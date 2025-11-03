# Changelog

All notable changes to the GitShift extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.2] - 2025-11-03

### Added

- **UI Changes**: Update the look of the Repository view for better look and consistency
- **Settings Button**: Added gear icon button in GitShift Manager pane header to quickly access extension settings
- **Per-Repository Account Association**: New configuration option to map repositories to specific GitHub accounts
  - `gitshift.repositoryAssociations`: Map repository paths to account emails
  - `gitshift.autoSwitchAccounts`: Toggle automatic account switching (default: enabled)
  - Automatically switches to the associated account when opening a repository
- **Keyboard Shortcuts for Account Switching**: Quick account switching with configurable keybindings
  - `Ctrl+Shift+1` (Cmd+Shift+1 on Mac) → Switch to Account 1
  - `Ctrl+Shift+2` → Switch to Account 2
  - `Ctrl+Shift+3` → Switch to Account 3
  - `Ctrl+Shift+4` → Switch to Account 4
  - `Ctrl+Shift+5` → Switch to Account 5
  - Switches to accounts based on their order in your accounts list

### Changed

- **Repository Webview Redesign**: Complete visual overhaul for a more professional, minimalist appearance
  - Redesigned tab navigation with underline-based active indicators
  - Improved responsive behavior with horizontal scroll and icon-only mode for narrow viewports
  - Consistent card styling matching the account-card design from sidebar
- **Changes Tab Improvements**:
  - Compact header with inline branch name and sync indicators
  - Inline stats display (staged/unstaged counts) replacing large stat cards
  - Minimalist action buttons (Pull, Push, Fetch, Refresh) with transparent backgrounds
  - Reduced commit box footprint with cleaner layout
  - Compact file list items with 6px padding and 3px gaps
  - Smaller file status icons (14px) for better density
- **Commits Tab Improvements**:
  - Moved HEAD, main, and origin badges to commit footer for better responsiveness
  - Reduced spacing between commit items (6px gap)
  - Compact header with reduced padding
  - Improved badge styling with better visual hierarchy
- **Branches Tab Updates**:
  - Consistent styling with other tabs
  - Improved spacing and padding for modern look

### Technical

- Auto-switch logic integrated with workspace folder change events
- Helper functions for account switching by index
- Configuration validation and repository path mapping
- Improved code organization for settings management

---

## [1.0.1] - Previous Release

### Features

- Multi-account GitHub management
- Git operations (commit, push, pull, fetch)
- Branch management
- Commit history viewer
- Personal access token support
- GitHub authentication integration
- Contribution graph visualization
- Quick repository cloning

### Initial Release

- Core extension functionality
- Sidebar webview for account management
- Repository status webview
- Status bar integration
- Git credential management
