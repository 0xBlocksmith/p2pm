// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

import { IP2PIntegrator } from "../../interfaces/IP2PIntegrator.sol";
import { IB2BGateway } from "../../interfaces/IB2BGateway.sol";
import { IOrderFlow } from "../../interfaces/IOrderFlow.sol";
import { ICheckoutClient } from "../../interfaces/ICheckoutClient.sol";
import { UserProxy } from "../../base/UserProxy.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { Clones } from "@openzeppelin/contracts/proxy/Clones.sol";

/**
 * @title MerchantTerminalIntegrator
 * @notice P2P merchant terminal: merchants accept local-currency payments from
 *         customers and receive USDC on Base under a settlement lock, then
 *         withdraw either as local fiat to their saved payout id (SELL offramp
 *         via the merchant proxy, TradeStars/Marketplace pattern) or as USDC to
 *         their wallet. The offramp currency is chosen per merchant at
 *         registration, so any country (INR/UPI, BRL/PIX, ARS, …) is supported
 *         — adding a new one needs only a funded circle, no contract change.
 *
 *         BUY flow: the merchant places the order (msg.sender), the order is
 *         routed through the merchant's UserProxy clone (B2BGatewayFacet is
 *         proxy-only), recipientAddr = the merchant's proxy and the
 *         integrator registers with usdcThroughIntegrator = false — the
 *         Diamond sends USDC to the proxy at completion and onOrderComplete
 *         pulls it into this contract, where it sits in settlement buckets
 *         (SETTLEMENT_PERIOD).
 *
 *         SELL flow (fiat withdrawal): the merchant's own proxy places the sell
 *         order; this contract funds that proxy with the USDC at placement and
 *         passes the merchant's RELAY PUBKEY (secp256k1, the same identity used
 *         for BUY) as userPubKey, in the merchant's own currency. The actual
 *         payout handle (UPI/PIX) is NOT placed on-chain here — it is delivered
 *         later, encrypted to that pubkey, via `deliverFiatPayout` →
 *         `setSellOrderUpi`. If a sell order is cancelled on the Diamond, the
 *         USDC is refunded to the proxy; `reconcileWithdrawal` sweeps it back and
 *         re-credits the merchant so no funds are stranded.
 *
 *         Limits enforced in validateOrder: 50 USDC per transaction and 4
 *         transactions per merchant per UTC day. The system proxy is carved
 *         out so withdrawals never hit merchant buy-side limits.
 */
contract MerchantTerminalIntegrator is IP2PIntegrator {
    using SafeERC20 for IERC20;

    // ─── Errors ───────────────────────────────────────────────────────
    error OnlyDiamond();
    error OnlyOwner();
    /// @dev Raised when the caller's role tier is below what an action requires.
    ///      Carries (required, actual) tier values so the admin panel can show
    ///      exactly which role is needed. required/actual are the Role enum uint8.
    error NotAuthorized(uint8 required, uint8 actual);
    error InvalidAddress();
    error AlreadyRegistered();
    error NotRegistered();
    /// @dev Named MerchantIsFrozen because events and errors share one
    ///      identifier namespace and the event MerchantFrozen keeps the
    ///      canonical name (the backend indexes events).
    error MerchantIsFrozen();
    error ExceedsPerTxCap();
    error DailyLimitReached();
    error InsufficientAvailableBalance();
    error NothingToWithdraw();
    error InvalidQuantity();
    error ProductNotFound();
    error TooManyBuckets();
    error Reentrancy();
    error UnknownWithdrawal();
    error WithdrawalNotCancellable();
    error WithdrawalAlreadySettled();
    error InvalidCircle();
    error OfframpFeeNotReady();
    error OfframpInsufficientPool();
    error WithdrawalNotFound();
    error InvalidCurrency();
    error WithdrawalInFlight();
    error FiatAlreadyDelivered();

    // ─── Events ───────────────────────────────────────────────────────
    event OrderPlaced(uint256 indexed orderId, address indexed user, uint256 amount);
    event UserProxyDeployed(address indexed user, address proxy);
    event MerchantRegistered(address indexed merchant, string payoutId, string shopName, bytes32 currency);
    event MerchantProfileUpdated(address indexed merchant, string payoutId, string shopName);
    event OrderCompleted(
        uint256 indexed orderId,
        address indexed merchant,
        uint256 amount,
        uint256 unlockTimestamp
    );
    event OrderCancelled(uint256 indexed orderId, address indexed merchant);
    event WithdrawalFiat(address indexed merchant, uint256 indexed orderId, bytes32 currency, uint256 amount);
    event WithdrawalUpiDelivered(uint256 indexed orderId, uint256 actualUsdtAmount);
    event WithdrawalUSDC(address indexed merchant, uint256 amount);
    event WithdrawalReconciled(address indexed merchant, uint256 indexed orderId, uint256 amount);
    event MerchantFrozen(address indexed merchant);
    event MerchantUnfrozen(address indexed merchant);
    event PerTxCapSet(bytes32 indexed currency, uint256 cap);
    event DailyLimitSet(uint256 newLimit);
    event TrustedRelayerSet(address indexed relayer);
    event AdminAdded(address indexed admin);
    event AdminRemoved(address indexed admin);
    /// @notice Emitted whenever an admin's role changes (including to NONE on
    ///         removal). `role` is the Role enum value
    ///         (0=NONE,1=VIEWER,2=SUPPORT,3=MANAGER,4=FINANCE).
    event AdminRoleSet(address indexed admin, uint8 role);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    // ─── Immutables ───────────────────────────────────────────────────
    address public immutable diamond;
    /// @notice Exposed as a public getter so the canonical UserProxy can
    ///         resolve which token to block from user-initiated sweep —
    ///         UserProxy.sweepERC20 calls `IUsdcSource(integrator()).usdc()`.
    IERC20 public immutable usdc;
    /// @notice Root admin. Set to the deployer at construction; transferable via
    ///         transferOwnership (e.g. to a team multisig). The owner manages the
    ///         admin set. NOT immutable so control can move without a redeploy.
    address public owner;
    /// @notice Pinned at deploy. Submit this address alongside the integrator
    ///         address when filing the whitelist request — the Diamond's
    ///         `registerIntegrator(integrator, proxyImpl, source)` records it
    ///         for the CREATE2-auth path that authorizes proxy calls.
    address public immutable proxyImpl;

    // ─── Constants ────────────────────────────────────────────────────
    /// @dev Per-transaction cap depends on the sale currency: India (INR) is
    ///      capped lower than other markets. `perTxCap(currency)` resolves it.
    ///      PER_TX_CAP is kept as the INR cap for source/ABI compatibility.
    uint256 public constant PER_TX_CAP = 50 * 1e6;         // INR: 50 USDC
    uint256 public constant PER_TX_CAP_INR = 50 * 1e6;     // India: 50 USDC
    uint256 public constant PER_TX_CAP_DEFAULT = 100 * 1e6; // other markets: 100 USDC
    /// @dev Default daily order limit. The LIVE limit is the mutable `dailyLimit`
    ///      below (admin-settable via setDailyLimit), initialised to this. The
    ///      constant is kept for source/ABI reference.
    uint256 public constant DAILY_TX_LIMIT = 25;
    uint256 public constant SETTLEMENT_PERIOD = 10 minutes;
    /// @dev Hard ceiling on a merchant's stored buckets. Withdrawals compact
    ///      spent buckets, so this bounds the per-call loop cost and prevents
    ///      an unbounded-array gas-griefing / self-DoS surface.
    uint256 public constant MAX_BUCKETS = 256;

    /// @dev Mirrors OrderProcessorStorage.OrderStatus on the Diamond — used
    ///      by reconcileWithdrawal to read the authoritative terminal state.
    uint8 internal constant STATUS_COMPLETED = 3;
    uint8 internal constant STATUS_CANCELLED = 4;

    // ─── State ────────────────────────────────────────────────────────

    struct SettlementBucket {
        uint256 amount;
        uint256 unlockTimestamp;
    }

    struct Merchant {
        address merchantAddr;
        string payoutId;     // generic payout handle: UPI / PIX key / CBU / alias
        string shopName;
        bytes32 currency;    // offramp currency, e.g. bytes32("INR"|"BRL"|"ARS") — set once at registration
        uint256 totalDeposited;
        bool isFrozen;
        uint256 dailyTxCount;
        uint256 lastTxDate;
        uint256 inFlightWithdrawals; // count of this merchant's unsettled SELL withdrawals
        SettlementBucket[] buckets;
    }

    /// @dev Tracks an in-flight INR withdrawal (SELL order) so a Diamond-side
    ///      cancellation can be reconciled: USDC refunded to the system proxy
    ///      is swept back and re-credited to the merchant as a fresh unlocked
    ///      bucket. `settled` is a replay guard.
    struct PendingWithdrawal {
        address merchant;
        uint256 amount;     // principal escrowed for THIS order (excludes fee)
        bool settled;
        bool upiDelivered; // setSellOrderUpi (fund+approve) has run for this SELL
        uint256 feeAdvanced; // fee topped up from the pool for THIS order (for exact recovery)
    }

    /// @notice Running sum of every merchant's bucket balance. The contract's
    ///         hard solvency invariant is `usdc.balanceOf(this) >= totalOwed`
    ///         at all times: protocol fees are charged to the withdrawing
    ///         merchant, never sourced from the commingled pool, so the pool
    ///         can never go under-collateralized against what merchants are owed.
    uint256 public totalOwed;

    mapping(address => Merchant) public merchants;
    mapping(address => bool) public registered;
    mapping(uint256 => address) public orderToMerchant;
    /// @notice BUY order id => the UTC day it was placed, so onOrderCancel only
    ///         releases a daily-count slot for the CURRENT day (a stale cross-day
    ///         cancel must not decrement a freshly-rolled counter).
    mapping(uint256 => uint256) public orderPlacementDay;
    mapping(uint256 => PendingWithdrawal) public withdrawals;
    /// @notice proxy address => the EOA it was deployed for. Set in
    ///         _ensureProxy. Lets validateOrder recognize a SELL placed by one
    ///         of our own merchant proxies (the carve-out) without trusting a
    ///         caller-supplied address.
    mapping(address => address) public proxyMerchant;

    /// @notice Optional per-currency per-tx cap override set by the owner. 0 =
    ///         no override (fall back to the INR/default rule). This lets a NEW
    ///         country get any cap on-chain from the admin dashboard WITHOUT a
    ///         contract change or redeploy — adding a country never touches code.
    mapping(bytes32 => uint256) public perTxCapOverride;

    /// @notice Live daily order limit per merchant (admin-settable via
    ///         setDailyLimit — no redeploy). Initialised to DAILY_TX_LIMIT (25).
    uint256 public dailyLimit;

    /// @notice Optional admin-set keeper allowed to call deliverFiatPayout on
    ///         behalf of merchants (e.g. a backend that watches for ACCEPTED
    ///         SELL orders and delivers the encrypted payout). address(0) = none.
    ///         The merchant and owner can always deliver; this just adds a keeper.
    ///         Set via setTrustedRelayer (MANAGER tier or higher).
    address public trustedRelayer;

    /// @notice Admin set for the admin dashboard. Kept as a plain bool for
    ///         backwards compatibility (isAdmin / ABI): true whenever the wallet
    ///         holds ANY non-NONE role. The role tier is in `adminRole` below.
    mapping(address => bool) public admins;

    /// @notice ROLE-BASED ACCESS CONTROL. Roles are HIERARCHICAL by value: a
    ///         higher tier can do everything a lower tier can, PLUS its own
    ///         actions. Five tiers, least-privilege:
    ///         • NONE    (0): not an admin.
    ///         • VIEWER  (1): read-only — all views, no writes. For auditors /
    ///                        support staff who only need to SEE merchant activity.
    ///         • SUPPORT (2): + freeze / unfreeze a merchant (the safety switch).
    ///         • MANAGER (3): + config — setPerTxCap, setDailyLimit, setTrustedRelayer.
    ///         • FINANCE (4): + money recovery — adminAbortWithdrawal, adminForceSettle.
    ///         The OWNER sits above all tiers (implicitly FINANCE) and is the ONLY
    ///         one who can assign roles, add/remove admins, or transfer ownership.
    enum Role { NONE, VIEWER, SUPPORT, MANAGER, FINANCE }
    mapping(address => Role) public adminRole;

    // ─── Reentrancy guard ─────────────────────────────────────────────
    uint256 private _locked = 1;

    modifier nonReentrant() {
        if (_locked != 1) revert Reentrancy();
        _locked = 2;
        _;
        _locked = 1;
    }

    // ─── Access modifiers ─────────────────────────────────────────────

    modifier onlyDiamond() {
        if (msg.sender != diamond) revert OnlyDiamond();
        _;
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert OnlyOwner();
        _;
    }

    /// @dev The owner's EFFECTIVE tier is FINANCE (the top admin tier), so a
    ///      single hierarchy check covers both the owner and any assigned admin.
    function _tier(address who) internal view returns (Role) {
        return who == owner ? Role.FINANCE : adminRole[who];
    }

    /// @dev Require caller's tier >= `min`. Roles are hierarchical, so gating an
    ///      action at MANAGER also admits FINANCE and the owner. Reverts
    ///      NotAuthorized with the required and actual tiers for a clear panel msg.
    modifier onlyRole(Role min) {
        Role have = _tier(msg.sender);
        if (uint8(have) < uint8(min)) revert NotAuthorized(uint8(min), uint8(have));
        _;
    }

    /// @notice True if `who` can perform ANY admin action (owner or any role).
    function isAdmin(address who) public view returns (bool) {
        return who == owner || adminRole[who] != Role.NONE;
    }

    /// @notice True if `who` can perform MANAGER (config) actions or higher.
    function isManager(address who) public view returns (bool) {
        return uint8(_tier(who)) >= uint8(Role.MANAGER);
    }

    /// @notice True if `who` can perform FINANCE (money-recovery) actions.
    function isFinance(address who) public view returns (bool) {
        return uint8(_tier(who)) >= uint8(Role.FINANCE);
    }

    /// @notice The role tier of `who` as a uint8 (0=NONE,1=VIEWER,2=SUPPORT,
    ///         3=MANAGER,4=FINANCE). The owner reads as 4 (FINANCE) so a panel can
    ///         render it uniformly, even though ownership is a higher capability.
    function roleOf(address who) external view returns (uint8) {
        return uint8(_tier(who));
    }

    // ─── Constructor ──────────────────────────────────────────────────

    constructor(address _diamond, address _usdc) {
        if (_diamond == address(0) || _usdc == address(0)) revert InvalidAddress();
        diamond = _diamond;
        usdc = IERC20(_usdc);
        owner = msg.sender;
        dailyLimit = DAILY_TX_LIMIT; // live limit starts at the default (25)
        // Deploy the canonical UserProxy implementation. Every per-user clone
        // is a `cloneDeterministicWithImmutableArgs` of this address, with
        // `(user, address(this))` packed as the immutable args.
        proxyImpl = address(new UserProxy());
    }

    // ─── Currency naming (string ⇄ bytes32) ──────────────────────────
    //
    // The offramp currency is stored as a `bytes32` because that's what the p2p
    // Diamond expects on every order. But a bytes32 like
    // 0x494e520000…00 is unreadable, so this contract speaks plain ISO-4217
    // currency CODES ("INR", "BRL", "ARS", "MXN", "NGN", …):
    //
    //   • `registerMerchant(payoutId, shopName, "BRL")`  ← human-readable string
    //   • `getMerchantCurrency(addr)` → "BRL"            ← read it back as text
    //
    // Any country is supported as long as the p2p protocol has a circle for that
    // currency code — adding one needs NO contract change.

    /// @notice Pack a currency code string ("INR") into the bytes32 the Diamond
    ///         uses. Reverts on empty / >31 chars. Pure, so anyone can preview it.
    function toCurrency(string memory code) public pure returns (bytes32 out) {
        bytes memory b = bytes(code);
        if (b.length == 0 || b.length > 31) revert InvalidCurrency();
        // Reject interior NUL bytes so the value always round-trips through
        // fromCurrency (which truncates at the first NUL). Otherwise "IN\0R"
        // would store distinctly yet display as "IN", and two merchants could
        // register codes that render identically but route to different circles.
        for (uint256 i = 0; i < b.length; i++) {
            if (b[i] == 0) revert InvalidCurrency();
        }
        assembly { out := mload(add(b, 32)) }
    }

    /// @notice Unpack a bytes32 currency back to its readable code string.
    function fromCurrency(bytes32 cur) public pure returns (string memory) {
        uint256 len = 0;
        while (len < 32 && cur[len] != 0) { len++; }
        bytes memory out = new bytes(len);
        for (uint256 i = 0; i < len; i++) { out[i] = cur[i]; }
        return string(out);
    }

    // ─── Merchant registration ────────────────────────────────────────

    /// @notice Register the calling merchant with a human-readable currency
    ///         CODE ("INR", "BRL", "ARS", …). This is the recommended entry
    ///         point — any country picks its ISO currency code and is supported
    ///         as long as the protocol has a circle for it. The payout id is a
    ///         generic string (UPI / PIX key / CBU / alias) — the contract never
    ///         interprets it; the country's LP knows how to pay it out.
    /// @param payoutId  Where local-fiat withdrawals land (UPI/PIX/CBU/…).
    /// @param shopName  Display name.
    /// @param currencyCode ISO-4217-style code, e.g. "INR", "BRL". Non-empty.
    function registerMerchant(
        string calldata payoutId,
        string calldata shopName,
        string calldata currencyCode
    ) external {
        _register(payoutId, shopName, toCurrency(currencyCode));
    }

    /// @notice Same as above but takes the packed bytes32 directly, for callers
    ///         that already have it (e.g. tooling). Most integrations should use
    ///         the string overload above.
    /// @param currency bytes32 offramp currency, e.g. bytes32("INR"). Non-zero.
    function registerMerchantRaw(
        string calldata payoutId,
        string calldata shopName,
        bytes32 currency
    ) external {
        _register(payoutId, shopName, currency);
    }

    /// @notice Update the caller's editable profile fields — payout handle
    ///         (UPI/PIX/CBU) and shop name. The offramp CURRENCY is intentionally
    ///         NOT editable: it's locked at registration because funds and
    ///         in-flight orders are denominated in it, and changing it mid-flight
    ///         could route a settlement to the wrong circle. To change currency,
    ///         a merchant uses a fresh wallet/registration.
    /// @param payoutId New payout handle (non-empty).
    /// @param shopName New display name.
    function updateProfile(string calldata payoutId, string calldata shopName) external {
        if (!registered[msg.sender]) revert NotRegistered();
        if (bytes(payoutId).length == 0) revert InvalidAddress();
        Merchant storage m = merchants[msg.sender];
        if (m.isFrozen) revert MerchantIsFrozen(); // a frozen merchant can't edit
        m.payoutId = payoutId;
        m.shopName = shopName;
        emit MerchantProfileUpdated(msg.sender, payoutId, shopName);
    }

    function _register(
        string calldata payoutId,
        string calldata shopName,
        bytes32 currency
    ) internal {
        if (registered[msg.sender]) revert AlreadyRegistered();
        if (currency == bytes32(0)) revert InvalidCurrency();
        // A payout target is required — without it fiat withdrawals have nowhere
        // to land (same rule updateProfile enforces).
        if (bytes(payoutId).length == 0) revert InvalidAddress();
        // AUDIT (MED): enforce CANONICAL bytes32 form on BOTH entry points —
        // left-aligned code, zero-padded, no non-zero byte after the first NUL.
        // registerMerchant's toCurrency already guarantees this; without the same
        // check here, registerMerchantRaw could smuggle "INR\0<junk>": it displays
        // as "INR" via fromCurrency but fails the `== bytes32("INR")` compare in
        // perTxCap, self-granting the 100 USDC default cap instead of INR's 50
        // (and dodging any admin setPerTxCap("INR") override).
        bool seenNul = false;
        for (uint256 i = 0; i < 32; i++) {
            if (currency[i] == 0) { seenNul = true; }
            else if (seenNul) { revert InvalidCurrency(); }
        }
        Merchant storage m = merchants[msg.sender];
        m.merchantAddr = msg.sender;
        m.payoutId = payoutId;
        m.shopName = shopName;
        m.currency = currency;
        registered[msg.sender] = true;
        emit MerchantRegistered(msg.sender, payoutId, shopName, currency);
    }

    // ─── IP2PIntegrator ───────────────────────────────────────────────

    /// @notice Per-transaction USDC cap for a given sale currency. If the owner
    ///         has set an override for this currency, that wins; otherwise India
    ///         (INR) is 50 USDC and every other market is 100 USDC. This means a
    ///         NEW country works with no contract change: it gets 100 USDC by
    ///         default, or any owner-set amount via setPerTxCap — never a redeploy.
    ///         View (reads the override mapping), so the UI can preview it.
    function perTxCap(bytes32 currency) public view returns (uint256) {
        uint256 ov = perTxCapOverride[currency];
        if (ov != 0) return ov;
        return currency == bytes32("INR") ? PER_TX_CAP_INR : PER_TX_CAP_DEFAULT;
    }

    function validateOrder(
        address user,
        uint256 amount,
        bytes32 currency
    ) external onlyDiamond returns (bool allowed) {
        // SELL self-call: order.user is a merchant's own proxy (owned by this
        // integrator), used as the placer for INR withdrawals. Withdrawal
        // limits were already enforced at the withdraw entry point, so merchant
        // buy-side limits do not apply here. proxyMerchant is set only for
        // proxies this contract deployed, so an arbitrary address cannot spoof
        // the carve-out.
        if (proxyMerchant[user] != address(0)) return true;

        if (!registered[user]) revert NotRegistered();
        Merchant storage m = merchants[user];
        if (m.isFrozen) revert MerchantIsFrozen();
        // Per-tx cap keys off the merchant's REGISTERED currency, NOT the
        // caller-supplied order currency — otherwise an INR merchant (50 USDC
        // cap) could pass currency="BRL" to unlock the 100 USDC default and
        // double their per-tx limit at will (audit MED). The cap reflects the
        // merchant's market (India 50 / others 100), which is a property of the
        // account, not of an individual sale's currency.
        if (amount > perTxCap(m.currency)) revert ExceedsPerTxCap();

        uint256 today = block.timestamp / 86400;
        if (m.lastTxDate != today) {
            m.dailyTxCount = 0;
            m.lastTxDate = today;
        }
        if (m.dailyTxCount >= dailyLimit) revert DailyLimitReached();
        m.dailyTxCount++;
        return true;
    }

    function onOrderComplete(
        uint256 orderId,
        address user,
        uint256 amount,
        address /* recipientAddr */
    ) external onlyDiamond {
        // recipientAddr = the merchant's proxy (usdcThroughIntegrator =
        // false): the Diamond just sent USDC there. Pull it into this
        // integrator, where it sits until the settlement bucket unlocks.
        UserProxy(proxyAddress(user)).transferERC20ToIntegrator(address(usdc), amount);

        _creditBucket(merchants[user], amount, block.timestamp + SETTLEMENT_PERIOD);
        merchants[user].totalDeposited += amount;

        emit OrderCompleted(orderId, user, amount, block.timestamp + SETTLEMENT_PERIOD);
    }

    /// @notice Best-effort: releases the daily-count slot consumed in
    ///         validateOrder. Tolerates unknown orderIds; deletes the
    ///         orderToMerchant entry so a repeated cancellation cannot
    ///         double-decrement.
    function onOrderCancel(uint256 orderId) external onlyDiamond {
        address merchant = orderToMerchant[orderId];
        if (merchant == address(0)) return; // SELL or unknown — nothing to release
        Merchant storage m = merchants[merchant];
        // MED-4: only release a slot for the CURRENT day. A day-N order cancelled
        // on day N+1 must NOT decrement N+1's freshly-rolled counter (that slot
        // was never consumed today). If the day already rolled, today's count is
        // effectively 0 for the stale order, so we skip the decrement.
        uint256 placedDay = orderPlacementDay[orderId];
        if (m.lastTxDate == placedDay && m.dailyTxCount > 0) {
            m.dailyTxCount--;
        }
        delete orderToMerchant[orderId];
        delete orderPlacementDay[orderId];
        emit OrderCancelled(orderId, merchant);
    }

    // ─── Order entry point (merchant-driven POS flow) ─────────────────

    function userPlaceOrder(
        address client,
        uint256 productId,
        uint256 quantity,
        bytes32 currency,
        uint256 circleId,
        string calldata pubKey
    ) external nonReentrant returns (uint256 orderId) {
        uint256 unitPrice = ICheckoutClient(client).getProductPrice(productId);
        if (unitPrice == 0) revert ProductNotFound();
        if (quantity == 0) revert InvalidQuantity();
        uint256 total = unitPrice * quantity;

        address proxy = _ensureProxy(msg.sender);
        // recipientAddr = the merchant's proxy: with usdcThroughIntegrator =
        // false the Diamond sends USDC there at completion and
        // onOrderComplete pulls it into this contract.
        bytes memory data = abi.encodeCall(
            IB2BGateway.placeB2BOrder,
            (msg.sender, total, currency, proxy, pubKey, circleId, 0, 0)
        );
        bytes memory result = UserProxy(proxy).execute(diamond, data, address(usdc), 0);
        orderId = abi.decode(result, (uint256));

        // validateOrder receives no orderId (the Diamond assigns it after
        // validation) — record the merchant here so onOrderCancel can
        // release the daily-count slot. Record the placement day too so a
        // stale cross-day cancellation can't decrement a different day's count.
        orderToMerchant[orderId] = msg.sender;
        orderPlacementDay[orderId] = block.timestamp / 86400;

        emit OrderPlaced(orderId, msg.sender, total);
    }

    // ─── Withdrawals ──────────────────────────────────────────────────

    /// @notice Withdraw unlocked USDC as local fiat in the merchant's REGISTERED
    ///         currency. Places a SELL order through the merchant's own proxy,
    ///         funded at placement. The payout handle (UPI/PIX) is delivered
    ///         LATER, encrypted, via `deliverFiatPayout` — so this call carries
    ///         the relay `pubKey` (secp256k1), NOT the payout string. The last
    ///         arg is retained for source/ABI compatibility but is unused on-chain.
    /// @param circleId The offramp circle on the Diamond for this currency,
    ///        resolved off-chain via the subgraph.
    /// @param pubKey Relay public key (the same identity used for BUY orders).
    function withdrawFiat(uint256 amount, uint256 circleId, string calldata pubKey, string calldata /* payoutOverride */)
        external
        nonReentrant
        returns (uint256 orderId)
    {
        Merchant storage m = _checkWithdraw(amount);
        return _withdrawFiat(m, amount, circleId, m.currency, pubKey);
    }

    /// @notice Withdraw unlocked USDC as local fiat in ANY currency the protocol
    ///         supports — not just the merchant's registered one. This lets a
    ///         merchant cash out funds they ACCEPTED in another currency (e.g. a
    ///         BRL payment) as that currency. Generic: the currency + payout are
    ///         caller-supplied; the contract enforces only that funds are the
    ///         merchant's own (per-merchant escrow + balance cap) and that the
    ///         Diamond accepts the currency/circle pair (else it reverts safely
    ///         and the USDC is recoverable via reconcileWithdrawal).
    /// @param currency The offramp currency (bytes32, e.g. "INR"|"BRL"). Non-zero.
    /// @param pubKey   Relay public key (secp256k1) — the Diamond stores it on the
    ///        SELL order so the LP can encrypt the payout to it. The actual payout
    ///        handle is delivered later via `deliverFiatPayout`, NOT here.
    function withdrawFiatIn(
        uint256 amount,
        uint256 circleId,
        bytes32 currency,
        string calldata pubKey
    ) external nonReentrant returns (uint256 orderId) {
        if (currency == bytes32(0)) revert InvalidCurrency();
        if (bytes(pubKey).length == 0) revert InvalidAddress();
        Merchant storage m = _checkWithdraw(amount);
        return _withdrawFiat(m, amount, circleId, currency, pubKey);
    }

    /// @dev Shared core for both fiat-withdrawal entry points. Currency + the
    ///      relay pubKey are passed in; everything else — per-merchant proxy
    ///      isolation, balance debit, serialization, escrow tracking — is
    ///      identical and currency-independent.
    /// @param pubKey The merchant's relay public key (secp256k1, the same
    ///        identity used for BUY). The Diamond stores this on the SELL order
    ///        and the LP encrypts the payout to it; the actual payout handle is
    ///        delivered later, encrypted, via `deliverFiatPayout`. This field is
    ///        NOT the payout id — passing a plain UPI/PIX string here makes the
    ///        LP reject the order ("invalid user pubkey").
    function _withdrawFiat(
        Merchant storage m,
        uint256 amount,
        uint256 circleId,
        bytes32 currency,
        string memory pubKey
    ) internal returns (uint256 orderId) {
        if (circleId == 0) revert InvalidCircle(); // friendly local guard
        if (bytes(pubKey).length == 0) revert InvalidAddress(); // need a real relay key
        // MED-1: serialize a merchant's fiat withdrawals. The merchant has ONE
        // proxy, so two concurrent SELLs would commingle principals on it and a
        // per-order top-up/reconcile (which key off the proxy's aggregate
        // balance) could pay one order's fee out of another's escrow.
        if (m.inFlightWithdrawals != 0) revert WithdrawalInFlight();
        _deductUnlocked(m, amount);

        // Per-merchant proxy: funds for THIS merchant's SELL sit only on the
        // merchant's own proxy, never commingled with other merchants'.
        address merchantProxy = _ensureProxy(m.merchantAddr);
        usdc.safeTransfer(merchantProxy, amount);
        // userPubKey = the relay pubkey (NOT the payout). The payout/UPI is set
        // later, encrypted, via deliverFiatPayout -> setSellOrderUpi.
        bytes memory data = abi.encodeCall(
            IB2BGateway.placeB2BSellOrder,
            (merchantProxy, amount, currency, pubKey, circleId, 0, 0)
        );
        bytes memory result = UserProxy(merchantProxy).execute(diamond, data, address(usdc), 0);
        orderId = abi.decode(result, (uint256));

        withdrawals[orderId] = PendingWithdrawal({
            merchant: m.merchantAddr,
            amount: amount,
            settled: false,
            upiDelivered: false,
            feeAdvanced: 0
        });
        m.inFlightWithdrawals++;

        emit WithdrawalFiat(m.merchantAddr, orderId, currency, amount);
    }

    /// @notice Second step of a fiat withdrawal: after the LP accepts the SELL
    ///         order, the Diamond pulls `actualUsdtAmount` (= principal + fee)
    ///         from the merchant proxy via transferFrom during setSellOrderUpi.
    ///         The proxy was funded with principal-only at withdrawFiat, so this
    ///         tops it up by the FEE from the integrator's USDC, grants the
    ///         allowance, and calls setSellOrderUpi so the Diamond can pull and
    ///         settle. Without this the Diamond auto-cancels the SELL (the
    ///         "fee bug"). Currency-agnostic — works for any offramp.
    ///
    ///         AUDIT-MED (griefing fix): this step is AUTHORIZED, not permissionless.
    ///         `encPayout` is the payout payload the LP decrypts — if any caller
    ///         could supply it, an attacker could front-run the real merchant,
    ///         mark upiDelivered with a bogus/attacker payload, brick the fiat
    ///         channel (owner-only recovery), and burn the merchant's fee. Only
    ///         the recorded merchant, the owner, or the owner-set trusted relayer
    ///         may deliver — all of which act on the merchant's behalf.
    /// @param encPayout The Diamond-encrypted payout payload for this order
    ///        (built off-chain from the order's pubkey + the merchant's saved
    ///        payout id), same as the BUY flow supplies a pubkey.
    function deliverFiatPayout(uint256 orderId, string calldata encPayout) external nonReentrant {
        PendingWithdrawal storage w = withdrawals[orderId];
        if (w.merchant == address(0)) revert WithdrawalNotFound();
        // Only the merchant, owner, or trusted relayer — never an arbitrary caller.
        if (msg.sender != w.merchant && msg.sender != owner && msg.sender != trustedRelayer)
            revert OnlyOwner();
        if (w.settled) revert WithdrawalAlreadySettled();
        if (w.upiDelivered) revert WithdrawalAlreadySettled();

        // HIGH-2: a frozen merchant's in-flight withdrawal must not settle.
        // Freeze is the only fraud kill-switch, so this permissionless step has
        // to honour it just like the withdraw entry point does.
        Merchant storage m = merchants[w.merchant];
        if (m.isFrozen) revert MerchantIsFrozen();

        // The Diamond pulls actualUsdtAmount (principal + fee) from order.user
        // (the merchant proxy) during setSellOrderUpi. Read it; refuse to run
        // until the Diamond has computed it (0 = not ready) rather than fall
        // back to principal-only, which re-introduces the fee bug.
        IOrderFlow.AdditionalOrderDetailsView memory aod =
            IOrderFlow(diamond).getAdditionalOrderDetails(orderId);
        uint256 needed = aod.actualUsdtAmount;
        if (needed == 0) revert OfframpFeeNotReady();

        // CEI: set the replay flag before the external call; a revert rolls it
        // back so a legitimate retry still works.
        w.upiDelivered = true;

        address merchantProxy = _ensureProxy(w.merchant);
        // The proxy holds this order's principal (`w.amount`). The Diamond needs
        // `needed` = principal + fee, so we top up the fee delta — but HIGH-1:
        // that fee is CHARGED TO THE WITHDRAWING MERCHANT (debited from their
        // own unlocked buckets), never sourced from the commingled pool. The
        // pool only physically forwards it; `totalOwed` drops by the fee, so the
        // solvency invariant `balanceOf(this) >= totalOwed` is preserved.
        uint256 proxyBal = usdc.balanceOf(merchantProxy);
        if (proxyBal < needed) {
            uint256 topUp = needed - proxyBal;
            // Debit the fee from the merchant's own unlocked balance. Reverts
            // InsufficientAvailableBalance if they can't cover it — the merchant
            // pays their own offramp fee, exactly like any real withdrawal.
            _deductUnlocked(m, topUp);
            if (usdc.balanceOf(address(this)) < topUp) revert OfframpInsufficientPool();
            w.feeAdvanced = topUp; // recorded so reconcile attributes it exactly
            usdc.safeTransfer(merchantProxy, topUp);
        }

        // Grant the Diamond an allowance of exactly `needed` and call
        // setSellOrderUpi. UserProxy.execute does NOT auto-sweep the USDC
        // remainder; any surplus left on the proxy is recovered later by
        // reconcileWithdrawal (which sweeps the full proxy balance).
        bytes memory data = abi.encodeCall(
            IOrderFlow.setSellOrderUpi,
            (orderId, encPayout, 0)
        );
        UserProxy(merchantProxy).execute(diamond, data, address(usdc), needed);

        emit WithdrawalUpiDelivered(orderId, needed);
    }

    /// @notice Withdraw unlocked USDC straight to the merchant's wallet.
    ///         Funds sit on this integrator (pulled at onOrderComplete).
    function withdrawUSDC(uint256 amount) external nonReentrant {
        Merchant storage m = _checkWithdraw(amount);
        _deductUnlocked(m, amount);

        usdc.safeTransfer(msg.sender, amount);

        emit WithdrawalUSDC(msg.sender, amount);
    }

    /// @notice Recover an INR withdrawal whose SELL order the Diamond
    ///         cancelled WITHOUT the merchant receiving fiat. Reads the
    ///         authoritative order from the Diamond (not a caller argument),
    ///         sweeps the refunded USDC off the MERCHANT'S OWN proxy, and
    ///         re-credits that merchant. Permissionless on purpose — anyone
    ///         can trigger recovery; the merchant is the only beneficiary.
    ///
    ///         Two safety properties vs. a naive "status == CANCELLED" check:
    ///         (1) funds are read from the merchant's own proxy, so attribution
    ///         is exact — no other merchant's parked funds can be swept; and
    ///         (2) we refuse to re-credit an order that shows evidence of fiat
    ///         delivery (an open/closed dispute), which would otherwise let a
    ///         merchant keep the INR AND reclaim USDC.
    /// @notice Recover a fiat withdrawal whose SELL the Diamond CANCELLED. This
    ///         covers BOTH the never-accepted (PLACED→CANCELLED) case AND the
    ///         accepted-then-clawed-back (PAID→CANCELLED) case — in the latter
    ///         the Diamond refunds principal+fee to the merchant's proxy, so the
    ///         merchant did NOT keep fiat and must be made whole (NEW-1 fix: the
    ///         old `upiDelivered` hard-block left PAID→CANCELLED unrecoverable
    ///         and permanently stuck the in-flight slot).
    ///
    ///         Double-spend safety (the MED-2 concern) is enforced STRUCTURALLY,
    ///         not by trusting a flag: we re-credit ONLY what is physically on
    ///         the proxy. If fiat was truly delivered to the merchant, the Diamond
    ///         did not refund the proxy, so proxyBal ≈ 0 and the re-credit is 0 —
    ///         the merchant cannot reclaim USDC they already converted to fiat.
    function reconcileWithdrawal(uint256 orderId) external nonReentrant {
        PendingWithdrawal storage w = withdrawals[orderId];
        if (w.merchant == address(0)) revert UnknownWithdrawal();
        if (w.settled) revert WithdrawalAlreadySettled();

        IOrderFlow.OrderView memory order = IOrderFlow(diamond).getOrdersById(orderId);
        if (order.status != STATUS_CANCELLED) revert WithdrawalNotCancellable();
        // Refuse on any recorded dispute — a disputed order may have had fiat
        // delivered; leave those to off-chain/admin resolution.
        if (order.disputeInfo.status != 0 || order.disputeInfo.raisedBy != 0)
            revert WithdrawalNotCancellable();

        w.settled = true;
        Merchant storage m = merchants[w.merchant];
        if (m.inFlightWithdrawals > 0) m.inFlightWithdrawals--;

        // MED-3: sweep the ENTIRE proxy balance back to the pool. Whatever the
        // Diamond refunded (principal only for PLACED→CANCELLED, principal+fee
        // for PAID→CANCELLED) is now physically here.
        address merchantProxy = _ensureProxy(w.merchant);
        uint256 proxyBal = usdc.balanceOf(merchantProxy);
        if (proxyBal > 0) {
            UserProxy(merchantProxy).transferERC20ToIntegrator(address(usdc), proxyBal);
        }

        // Re-credit principal + any fee advanced (the fee was charged to the
        // merchant at delivery but no fiat was rendered, so refund it), capped by
        // what was ACTUALLY refunded to the proxy (structural double-spend guard:
        // no refund → no re-credit).
        uint256 owedBack = w.amount + w.feeAdvanced;
        uint256 recredit = owedBack < proxyBal ? owedBack : proxyBal;
        // Re-lock under a fresh settlement window when the SELL had reached PAID
        // (fiat attempted) OR the merchant is FROZEN — a frozen account must not
        // get instantly-spendable funds back (mirrors adminAbortWithdrawal's
        // intent), otherwise this permissionless path would undermine the freeze.
        // Only the clean never-accepted, not-frozen case unlocks immediately.
        uint256 unlockAt = (w.upiDelivered || m.isFrozen)
            ? block.timestamp + SETTLEMENT_PERIOD
            : block.timestamp - 1;
        _creditBucket(m, recredit, unlockAt);

        emit WithdrawalReconciled(w.merchant, orderId, recredit);
    }

    /// @notice Mark an INR withdrawal as successfully completed (frees the
    ///         tracking slot). Permissionless; only flips a withdrawal whose
    ///         Diamond status is COMPLETED, so it cannot be abused to block
    ///         a legitimate reconciliation.
    function finalizeWithdrawal(uint256 orderId) external {
        PendingWithdrawal storage w = withdrawals[orderId];
        if (w.merchant == address(0)) revert UnknownWithdrawal();
        if (w.settled) revert WithdrawalAlreadySettled();
        uint8 status = IOrderFlow(diamond).getOrdersById(orderId).status;
        if (status != STATUS_COMPLETED) revert WithdrawalNotCancellable();
        w.settled = true;
        Merchant storage m = merchants[w.merchant];
        if (m.inFlightWithdrawals > 0) m.inFlightWithdrawals--;
    }

    function _checkWithdraw(uint256 amount) internal view returns (Merchant storage m) {
        if (!registered[msg.sender]) revert NotRegistered();
        m = merchants[msg.sender];
        if (m.isFrozen) revert MerchantIsFrozen();
        if (amount == 0) revert NothingToWithdraw();
    }

    /// @dev Append an unlocked/locked bucket, compacting fully-spent buckets
    ///      first so the array stays bounded by MAX_BUCKETS. Coalesces a new
    ///      credit into an existing bucket with the SAME unlock timestamp so a
    ///      merchant's live-bucket count cannot grow without bound (and the
    ///      credit path can never revert at the cap and strand a deposit).
    function _creditBucket(Merchant storage m, uint256 amount, uint256 unlockTimestamp) internal {
        if (amount == 0) return;
        totalOwed += amount;
        _compact(m);
        // Fold into an existing bucket sharing this unlock window if present.
        uint256 len = m.buckets.length;
        for (uint256 i = 0; i < len; i++) {
            if (m.buckets[i].unlockTimestamp == unlockTimestamp) {
                m.buckets[i].amount += amount;
                return;
            }
        }
        // No matching window — must append. If at the cap, fold the new credit
        // into the oldest live bucket rather than revert: this keeps the credit
        // path infallible (a completed deposit can ALWAYS be recorded).
        if (m.buckets.length >= MAX_BUCKETS) {
            uint256 oldest = 0;
            uint256 oldestTs = type(uint256).max;
            for (uint256 i = 0; i < len; i++) {
                if (m.buckets[i].unlockTimestamp < oldestTs) {
                    oldestTs = m.buckets[i].unlockTimestamp;
                    oldest = i;
                }
            }
            // The folded credit adopts the LATER of the two unlock times, so it
            // can never unlock EARLIER than its own intended time, and — NEW-2
            // fix — it never lowers an already-locked bucket's unlock below
            // block.timestamp (a past-dated reconcile credit must not make the
            // host bucket's locked principal spendable early). The folded credit
            // may unlock slightly later than requested; that is the safe
            // direction at the (rare) cap.
            if (unlockTimestamp > m.buckets[oldest].unlockTimestamp) {
                m.buckets[oldest].unlockTimestamp = unlockTimestamp;
            }
            m.buckets[oldest].amount += amount;
            return;
        }
        m.buckets.push(SettlementBucket({ amount: amount, unlockTimestamp: unlockTimestamp }));
    }

    /// @dev Removes ALL fully-spent (amount == 0) buckets, preserving order of
    ///      the live ones. A stable compaction: spent buckets can appear
    ///      anywhere (a locked bucket can sit in front of a spent unlocked
    ///      one), so a head-only pass would leave interior zeros and let the
    ///      array drift toward MAX_BUCKETS. This pass reclaims every zero.
    function _compact(Merchant storage m) internal {
        uint256 len = m.buckets.length;
        uint256 write = 0;
        for (uint256 read = 0; read < len; read++) {
            if (m.buckets[read].amount != 0) {
                if (write != read) {
                    m.buckets[write] = m.buckets[read];
                }
                write++;
            }
        }
        // Pop the tail left after compaction (len - write spent slots).
        while (m.buckets.length > write) {
            m.buckets.pop();
        }
    }

    /// @dev Sums unlocked buckets, reverts if short, then deducts
    ///      oldest-first (buckets are pushed chronologically).
    function _deductUnlocked(Merchant storage m, uint256 amount) internal {
        uint256 unlocked = 0;
        uint256 len = m.buckets.length;
        for (uint256 i = 0; i < len; i++) {
            if (m.buckets[i].unlockTimestamp < block.timestamp) {
                unlocked += m.buckets[i].amount;
            }
        }
        if (unlocked < amount) revert InsufficientAvailableBalance();

        totalOwed -= amount;
        uint256 remaining = amount;
        for (uint256 i = 0; i < len && remaining > 0; i++) {
            SettlementBucket storage b = m.buckets[i];
            if (b.unlockTimestamp >= block.timestamp || b.amount == 0) continue;
            uint256 take = b.amount < remaining ? b.amount : remaining;
            b.amount -= take;
            remaining -= take;
        }
    }

    // ─── Admin ────────────────────────────────────────────────────────

    /// @notice OWNER-ONLY: assign an admin's role tier. This is the single entry
    ///         point for role-based access. Roles are hierarchical — a higher tier
    ///         includes every lower tier's powers. Pass Role.NONE to revoke. Keeps
    ///         the legacy `admins` bool in sync (true for any non-NONE role) so
    ///         isAdmin / existing integrations keep working. No redeploy needed.
    /// @param who  The admin wallet.
    /// @param role 0=NONE(revoke) 1=VIEWER 2=SUPPORT 3=MANAGER 4=FINANCE.
    function setRole(address who, Role role) public onlyOwner {
        if (who == address(0)) revert InvalidAddress();
        bool wasAdmin = adminRole[who] != Role.NONE;
        adminRole[who] = role;
        admins[who] = role != Role.NONE;
        emit AdminRoleSet(who, uint8(role));
        // Keep the legacy add/remove events firing for any listener still on them.
        if (role != Role.NONE && !wasAdmin) emit AdminAdded(who);
        if (role == Role.NONE && wasAdmin) emit AdminRemoved(who);
    }

    /// @notice OWNER-ONLY: add an admin. Back-compat shim — grants FINANCE (the
    ///         full admin tier, matching the previous flat-admin behaviour where a
    ///         single admin could do everything). Use setRole(who, <tier>) for a
    ///         narrower role (e.g. Role.SUPPORT for freeze-only, Role.VIEWER for
    ///         read-only).
    function addAdmin(address who) external onlyOwner {
        setRole(who, Role.FINANCE);
    }

    /// @notice OWNER-ONLY: remove an admin (revoke all roles).
    function removeAdmin(address who) external onlyOwner {
        setRole(who, Role.NONE);
    }

    /// @notice OWNER-ONLY: move root ownership (e.g. to a team multisig). The new
    ///         owner then controls the admin set and can transfer again. Reverts
    ///         on the zero address to avoid bricking admin control.
    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert InvalidAddress();
        address prev = owner;
        owner = newOwner;
        emit OwnershipTransferred(prev, newOwner);
    }

    /// @notice Set (or clear) the per-transaction USDC cap for a currency. Lets
    ///         the team onboard a NEW country and tune its cap entirely from the
    ///         admin dashboard — no contract change, no redeploy. Pass cap = 0 to
    ///         clear the override and fall back to the INR/default rule.
    /// @param currency The sale currency (bytes32, e.g. bytes32("MXN")).
    /// @param cap      Per-tx cap in USDC 6-decimals (e.g. 75 * 1e6). 0 = clear.
    function setPerTxCap(bytes32 currency, uint256 cap) external onlyRole(Role.MANAGER) {
        if (currency == bytes32(0)) revert InvalidCurrency();
        perTxCapOverride[currency] = cap;
        emit PerTxCapSet(currency, cap);
    }

    /// @notice Set the live daily order limit per merchant (admin-settable — no
    ///         redeploy). Must be non-zero (0 would block all orders). Applies
    ///         from the next order; a merchant already at/over the new lower
    ///         limit simply can't place more today.
    /// @param newLimit New max orders per merchant per UTC day.
    function setDailyLimit(uint256 newLimit) external onlyRole(Role.MANAGER) {
        if (newLimit == 0) revert InvalidQuantity();
        dailyLimit = newLimit;
        emit DailyLimitSet(newLimit);
    }

    /// @notice Set (or clear via address(0)) the keeper allowed to call
    ///         deliverFiatPayout on merchants' behalf. Owner + merchant can
    ///         always deliver regardless.
    function setTrustedRelayer(address relayer) external onlyRole(Role.MANAGER) {
        trustedRelayer = relayer;
        emit TrustedRelayerSet(relayer);
    }

    /// @dev SUPPORT tier or higher — freezing is the baseline safety action.
    function freezeMerchant(address merchant) external onlyRole(Role.SUPPORT) {
        merchants[merchant].isFrozen = true;
        emit MerchantFrozen(merchant);
    }

    /// @dev SUPPORT tier or higher.
    function unfreezeMerchant(address merchant) external onlyRole(Role.SUPPORT) {
        merchants[merchant].isFrozen = false;
        emit MerchantUnfrozen(merchant);
    }

    /// @notice HIGH-2 admin recovery: claw a FROZEN merchant's in-flight, not-yet-
    ///         delivered fiat withdrawal back into the pool, independent of the
    ///         Diamond's order status. Only callable while the merchant is frozen
    ///         and only for a withdrawal whose fiat was never delivered
    ///         (upiDelivered == false) — so it can never reverse a real payout.
    ///         Sweeps the merchant's proxy USDC back, re-credits their principal
    ///         (locked again under a fresh settlement period so a frozen account
    ///         can't immediately re-extract), and frees the in-flight slot.
    function adminAbortWithdrawal(uint256 orderId) external onlyRole(Role.FINANCE) nonReentrant {
        PendingWithdrawal storage w = withdrawals[orderId];
        if (w.merchant == address(0)) revert UnknownWithdrawal();
        if (w.settled) revert WithdrawalAlreadySettled();
        if (w.upiDelivered) revert FiatAlreadyDelivered();
        Merchant storage m = merchants[w.merchant];
        if (!m.isFrozen) revert MerchantIsFrozen(); // only for frozen accounts

        w.settled = true;
        if (m.inFlightWithdrawals > 0) m.inFlightWithdrawals--;

        address merchantProxy = _ensureProxy(w.merchant);
        uint256 proxyBal = usdc.balanceOf(merchantProxy);
        if (proxyBal > 0) {
            UserProxy(merchantProxy).transferERC20ToIntegrator(address(usdc), proxyBal);
        }
        // Make the merchant whole for principal + any fee advanced (capped by
        // the actual proxy refund, so still double-spend-safe).
        uint256 owedBack = w.amount + w.feeAdvanced;
        uint256 recredit = owedBack < proxyBal ? owedBack : proxyBal;
        // Re-lock under a fresh settlement window — a frozen merchant shouldn't
        // get instantly-available funds back; unfreeze + normal flow applies.
        _creditBucket(m, recredit, block.timestamp + SETTLEMENT_PERIOD);

        emit WithdrawalReconciled(w.merchant, orderId, recredit);
    }

    /// @notice FINAL-AUDIT fix (disputed-clawback channel-brick): an owner-gated
    ///         recovery for an in-flight withdrawal that NO other settle path can
    ///         close — specifically a PAID→disputed→CANCELLED order, where
    ///         reconcileWithdrawal refuses the dispute, finalizeWithdrawal needs
    ///         COMPLETED, and adminAbortWithdrawal refuses upiDelivered. Without
    ///         this, inFlightWithdrawals stays stuck (bricking the merchant's
    ///         whole fiat channel) and the Diamond's proxy refund is stranded.
    ///
    ///         Double-spend safety is structural and unconditional: we re-credit
    ///         ONLY what is physically refunded to the proxy. If fiat actually
    ///         reached the merchant, the Diamond did not refund the proxy, so
    ///         proxyBal ≈ 0 and recredit ≈ 0. Owner-gated and requires the
    ///         Diamond status to be CANCELLED (a real clawback), so it cannot be
    ///         used to reverse a COMPLETED payout.
    function adminForceSettle(uint256 orderId) external onlyRole(Role.FINANCE) nonReentrant {
        PendingWithdrawal storage w = withdrawals[orderId];
        if (w.merchant == address(0)) revert UnknownWithdrawal();
        if (w.settled) revert WithdrawalAlreadySettled();

        // Only for orders the Diamond clawed back — never a completed payout.
        uint8 status = IOrderFlow(diamond).getOrdersById(orderId).status;
        if (status != STATUS_CANCELLED) revert WithdrawalNotCancellable();

        w.settled = true;
        Merchant storage m = merchants[w.merchant];
        if (m.inFlightWithdrawals > 0) m.inFlightWithdrawals--;

        address merchantProxy = _ensureProxy(w.merchant);
        uint256 proxyBal = usdc.balanceOf(merchantProxy);
        if (proxyBal > 0) {
            UserProxy(merchantProxy).transferERC20ToIntegrator(address(usdc), proxyBal);
        }
        // Make whole for principal + fee, capped by the physical refund.
        uint256 owedBack = w.amount + w.feeAdvanced;
        uint256 recredit = owedBack < proxyBal ? owedBack : proxyBal;
        // Re-lock under a fresh settlement window (the order had reached PAID).
        _creditBucket(m, recredit, block.timestamp + SETTLEMENT_PERIOD);

        emit WithdrawalReconciled(w.merchant, orderId, recredit);
    }

    // ─── Views ────────────────────────────────────────────────────────

    /// @notice Balances derived from buckets at the current timestamp —
    ///         `pending` counts only still-locked buckets, `available` only
    ///         unlocked ones.
    function getMerchantBalance(
        address merchant
    )
        external
        view
        returns (uint256 pending, uint256 available, uint256 totalDeposited, bool isFrozen)
    {
        Merchant storage m = merchants[merchant];
        uint256 len = m.buckets.length;
        for (uint256 i = 0; i < len; i++) {
            if (m.buckets[i].unlockTimestamp < block.timestamp) {
                available += m.buckets[i].amount;
            } else {
                pending += m.buckets[i].amount;
            }
        }
        return (pending, available, m.totalDeposited, m.isFrozen);
    }

    /// @notice The public `merchants` auto-getter omits the buckets array —
    ///         this exposes it for tests and the dashboard.
    function getMerchantBuckets(
        address merchant
    ) external view returns (SettlementBucket[] memory) {
        return merchants[merchant].buckets;
    }

    /// @notice On-chain merchant profile, so the UI needs no off-chain store.
    ///         Returns the saved payout id (where fiat withdrawals are paid),
    ///         shop name, offramp currency, registration status, and freeze status.
    function getMerchantInfo(
        address merchant
    )
        external
        view
        returns (string memory payoutId, string memory shopName, bytes32 currency, bool isRegistered, bool isFrozen)
    {
        Merchant storage m = merchants[merchant];
        return (m.payoutId, m.shopName, m.currency, registered[merchant], m.isFrozen);
    }

    function getDailyTxInfo(
        address merchant
    ) external view returns (uint256 usedToday, uint256 limit) {
        Merchant storage m = merchants[merchant];
        uint256 today = block.timestamp / 86400;
        usedToday = m.lastTxDate == today ? m.dailyTxCount : 0;
        return (usedToday, dailyLimit);
    }

    /// @notice The merchant's offramp currency as a readable code ("INR",
    ///         "BRL", …) — so the UI never has to decode a bytes32.
    function getMerchantCurrency(address merchant) external view returns (string memory) {
        return fromCurrency(merchants[merchant].currency);
    }

    // ─── Proxy helpers (mirror ExampleIntegrator exactly) ─────────────

    /// @notice Predicts the deterministic UserProxy address for `user`.
    ///         The clone may not yet be deployed — check `code.length` if
    ///         you need to know.
    function proxyAddress(address user) public view returns (address) {
        return
            Clones.predictDeterministicAddressWithImmutableArgs(
                proxyImpl,
                _proxyArgs(user),
                _salt(user),
                address(this)
            );
    }

    /// @dev Salt is the user EOA only. The "deployer" component of the
    ///      CREATE2 address derivation is the integrator (this contract),
    ///      so a (integrator, user) pair maps to exactly one proxy address.
    function _salt(address user) internal pure returns (bytes32) {
        return bytes32(uint256(uint160(user)));
    }

    /// @dev Immutable args layout: [owner(20)][integrator(20)] — 40 bytes.
    ///      UserProxy.owner() and UserProxy.integrator() read these slots
    ///      via `Clones.fetchCloneArgs(address(this))`. The Diamond's
    ///      CREATE2-auth path reconstructs the same args from the registered
    ///      proxyImpl + user salt, so DO NOT change the layout.
    function _proxyArgs(address user) internal view returns (bytes memory) {
        return abi.encodePacked(user, address(this));
    }

    function _ensureProxy(address user) internal returns (address proxy) {
        proxy = proxyAddress(user);
        if (proxy.code.length == 0) {
            address deployed = Clones.cloneDeterministicWithImmutableArgs(
                proxyImpl,
                _proxyArgs(user),
                _salt(user)
            );
            assert(deployed == proxy);
            // Record proxy => owner so validateOrder can recognize a SELL
            // placed by one of our own merchant proxies.
            proxyMerchant[proxy] = user;
            emit UserProxyDeployed(user, proxy);
        }
    }
}
