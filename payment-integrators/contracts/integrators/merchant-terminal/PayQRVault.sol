// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @dev Minimal view into the integrator, used ONLY to prove the two-sided link
///      is mutual before authorising it: setIntegrator checks that the candidate
///      integrator already points its `vault` back at this vault. This closes the
///      migration-desync gap — the vault can never be pointed at an integrator
///      that isn't itself pointed here, so deposits (integrator→vault) and pulls
///      (vault→integrator) can never target mismatched contracts.
interface IIntegratorLink {
    function vault() external view returns (address);
}

/**
 * @title PayQRVault
 * @notice Segregated custody for the PayQR merchant terminal. Holds ALL merchant
 *         USDC; the integrator keeps every bit of accounting (settlement buckets,
 *         totalOwed, roles, limits) but no longer holds funds — it asks the vault
 *         to move USDC via `pull`.
 *
 *         Why a separate vault (team requirements):
 *           • YIELD (future): idle balance can be deployed to a strategy without
 *             touching the integrator. (No strategy in v1 — funds stay 100% liquid;
 *             a future owner-gated `setStrategy` slots in without changing `pull`.)
 *           • MIGRATION: if the integrator changes, the vault owner just repoints
 *             `setIntegrator(new)`. No USDC moves.
 *           • KILL-SWITCH: if the integrator looks compromised, an owner `lock()`s
 *             the vault — all pulls revert until it's `unlock()`ed.
 *
 *         AIRTIGHT INTEGRATOR LINK (the security core):
 *           • The vault is deliberately DUMB about ownership and SMART about access.
 *             It does not re-derive who is owed what (that is the integrator's
 *             tested job). It only guarantees: "only the ONE linked integrator can
 *             move USDC, and never while locked."
 *           • `pull` is the ONLY exit — one function, USDC-only, guarded by
 *             onlyIntegrator + whenNotLocked + nonReentrant. No arbitrary call, no
 *             approve to third parties, no pullFrom.
 *
 *         MULTI-OWNER governance: a SET of owners, each with full access (add/remove
 *         owners, set the integrator, lock/unlock). The deployer is the first owner;
 *         additional owners can be seeded at construction and managed later. The
 *         last owner can never be removed (so the vault can't be orphaned).
 */
contract PayQRVault {
    using SafeERC20 for IERC20;

    // ─── Errors ───────────────────────────────────────────────────────
    error NotOwner();
    error NotIntegrator();
    error VaultLocked();
    error BadPull();
    error InvalidAddress();
    error Reentrancy();
    error LastOwner();
    error AlreadySet();
    /// @dev The candidate integrator does not point its `vault` back at this
    ///      vault — the two-sided link would be asymmetric, so we refuse it.
    error LinkMismatch();

    // ─── Events ───────────────────────────────────────────────────────
    event Pulled(address indexed to, uint256 amount);
    event IntegratorSet(address indexed previous, address indexed next);
    event Locked(address indexed by);
    event Unlocked(address indexed by);
    event OwnerAdded(address indexed owner);
    event OwnerRemoved(address indexed owner);

    // ─── State ────────────────────────────────────────────────────────
    /// @notice The custodied token (USDC). Immutable.
    IERC20 public immutable usdc;
    /// @notice The single integrator authorised to pull funds. Repointed on
    ///         migration via setIntegrator. Only this address can call `pull`.
    address public integrator;
    /// @notice Break-glass: when true, ALL pulls revert. Owners flip it.
    bool public locked;
    /// @notice Multi-owner set — each owner has full governance access.
    mapping(address => bool) public isOwner;
    uint256 public ownerCount;

    // ─── Reentrancy guard ─────────────────────────────────────────────
    uint256 private _locked = 1;
    modifier nonReentrant() {
        if (_locked != 1) revert Reentrancy();
        _locked = 2;
        _;
        _locked = 1;
    }

    // ─── Access ───────────────────────────────────────────────────────
    modifier onlyOwner() {
        if (!isOwner[msg.sender]) revert NotOwner();
        _;
    }
    modifier onlyIntegrator() {
        if (msg.sender != integrator) revert NotIntegrator();
        _;
    }
    modifier whenNotLocked() {
        if (locked) revert VaultLocked();
        _;
    }

    /**
     * @param _usdc   the token this vault custodies.
     * @param _owners initial owner set — each gets full access. Must be non-empty;
     *                the deployer is added automatically if not already present.
     */
    constructor(address _usdc, address[] memory _owners) {
        if (_usdc == address(0)) revert InvalidAddress();
        usdc = IERC20(_usdc);
        // Seed the deployer as an owner.
        _addOwner(msg.sender);
        for (uint256 i = 0; i < _owners.length; i++) {
            if (_owners[i] != address(0) && !isOwner[_owners[i]]) _addOwner(_owners[i]);
        }
    }

    // ─── The ONE exit ─────────────────────────────────────────────────
    /**
     * @notice Move `amount` USDC to `to`. The ONLY way funds leave the vault.
     *         Callable only by the linked integrator, only while unlocked.
     * @dev The vault does no ownership accounting — the integrator has already
     *      validated who is owed what before calling this.
     */
    function pull(address to, uint256 amount) external onlyIntegrator whenNotLocked nonReentrant {
        if (to == address(0) || amount == 0) revert BadPull();
        usdc.safeTransfer(to, amount);
        emit Pulled(to, amount);
    }

    // ─── Migration ────────────────────────────────────────────────────
    /**
     * @notice Point the vault at the integrator authorised to pull. This IS the
     *         migration primitive: on a new integrator, owners call this; no USDC
     *         moves. Setting address(0) effectively disables pulls (belt-and-braces
     *         alongside lock()).
     *
     * @dev AIRTIGHT LINK: a non-zero `next` MUST already point its own `vault`
     *      back at this vault (a mutual handshake). This makes the two-sided link
     *      impossible to desync — you cannot authorise an integrator here unless
     *      it is provably wired here too, so deposits (integrator→vault) and pulls
     *      (vault→integrator) can never target mismatched custody. The moment this
     *      returns, the OLD integrator is powerless (onlyIntegrator checks the new
     *      value) and the new one is live — the switch is atomic in one tx.
     *      address(0) skips the check (it only disables pulls, authorises nothing).
     */
    function setIntegrator(address next) external onlyOwner {
        if (next != address(0) && IIntegratorLink(next).vault() != address(this)) {
            revert LinkMismatch();
        }
        address prev = integrator;
        integrator = next;
        emit IntegratorSet(prev, next);
    }

    // ─── Kill-switch ──────────────────────────────────────────────────
    function lock() external onlyOwner {
        if (locked) revert AlreadySet();
        locked = true;
        emit Locked(msg.sender);
    }
    function unlock() external onlyOwner {
        if (!locked) revert AlreadySet();
        locked = false;
        emit Unlocked(msg.sender);
    }

    // ─── Multi-owner management ───────────────────────────────────────
    function addOwner(address who) external onlyOwner {
        if (who == address(0)) revert InvalidAddress();
        if (isOwner[who]) revert AlreadySet();
        _addOwner(who);
    }
    function removeOwner(address who) external onlyOwner {
        if (!isOwner[who]) revert InvalidAddress();
        if (ownerCount == 1) revert LastOwner(); // never orphan the vault
        isOwner[who] = false;
        ownerCount--;
        emit OwnerRemoved(who);
    }
    function _addOwner(address who) internal {
        isOwner[who] = true;
        ownerCount++;
        emit OwnerAdded(who);
    }

    // ─── Views ────────────────────────────────────────────────────────
    /// @notice USDC currently held by the vault (the integrator's solvency base).
    function balance() external view returns (uint256) {
        return usdc.balanceOf(address(this));
    }
}
