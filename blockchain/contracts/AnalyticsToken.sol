// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// --------------------------------------------------------------------------
// AnalyticsToken.sol – ERC-20 token with on-chain wallet activity tracking
// --------------------------------------------------------------------------
// Every transfer automatically emits a `WalletActivity` event that the
// dashboard's event-sync service can index for real-time analytics.
// --------------------------------------------------------------------------

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

contract AnalyticsToken is ERC20, Ownable {
    // ------------------------------------------------------------------
    // Events
    // ------------------------------------------------------------------

    /// @notice Emitted on every token movement for off-chain analytics indexing.
    /// @param wallet       The address whose balance changed.
    /// @param activityType Human-readable label ("TRANSFER" or "RECEIVE").
    /// @param amount       The raw token value (wei-denominated).
    /// @param timestamp    Block timestamp at the time of the transfer.
    event WalletActivity(
        address indexed wallet,
        string activityType,
        uint256 amount,
        uint256 timestamp
    );

    // ------------------------------------------------------------------
    // Constructor
    // ------------------------------------------------------------------

    /// @param initialSupply Number of whole tokens to mint (before decimals).
    constructor(uint256 initialSupply)
        ERC20("AnalyticsToken", "ANLT")
        Ownable(msg.sender)
    {
        _mint(msg.sender, initialSupply * 10 ** decimals());
    }

    // ------------------------------------------------------------------
    // Internal overrides
    // ------------------------------------------------------------------

    /// @dev Hook into every token movement (mint / burn / transfer).
    ///      Emits WalletActivity for both sender and receiver so the
    ///      analytics pipeline has a complete picture of wallet behaviour.
    function _update(
        address from,
        address to,
        uint256 value
    ) internal virtual override {
        // Execute the actual balance update first.
        super._update(from, to, value);

        // Emit for the sender (skip mints where from == address(0)).
        if (from != address(0)) {
            emit WalletActivity(from, "TRANSFER", value, block.timestamp);
        }

        // Emit for the receiver (skip burns where to == address(0)).
        if (to != address(0)) {
            emit WalletActivity(to, "RECEIVE", value, block.timestamp);
        }
    }
}
