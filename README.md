# GitShift

[![Version](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2Fmikeeeyy04%2FGitShift%2Fmain%2Fpackage.json&query=%24.version&label=version&color=blue)](https://marketplace.visualstudio.com/items?itemName=mikeeeyy04.gitshift)
[![VS Code Version](https://img.shields.io/badge/VS%20Code-1.90.0+-blue.svg)](https://code.visualstudio.com/)
[![License](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

![GitShift Demo](https://i.imgur.com/cqwPE8H.gif)

A powerful VS Code extension that helps developers seamlessly switch between multiple GitHub accounts for commits and pushes. Never commit with the wrong identity again!

## Features

- **GitHub Authentication**: Sign in with real GitHub accounts using VS Code's built-in authentication for full push/pull access
- **Beautiful Sidebar Panel**: Dedicated Activity Bar view with minimalist dark theme and intuitive UI
- **Rich Account Manager**: Full-featured webview manager with add/edit/delete capabilities
- **One-Click Account Switching**: Switch between multiple GitHub accounts instantly
- **Status Bar Integration**: Always see your current Git identity at a glance
- **Smart Auto-Detection**: Automatically detects and displays your current Git configuration
- **Automatic Credential Management**: Configures git credentials automatically when using authenticated accounts
- **Workspace-Specific Configuration**: Git configuration is set per workspace, keeping your projects organized
- **Repository Management**: Built-in repository viewer with changes, branches, and commits
- **Contributions Graph**: Visualize your GitHub contributions calendar
- **GitHub Notifications**: View and manage your GitHub notifications
- **Quick Clone**: Clone repositories and automatically switch to the appropriate account
- **Secure Token Storage**: Uses VS Code's secure secret storage for all tokens

![GitShift Demo](images/demo.png)

## Installation

### From VS Code Marketplace (Recommended)

1. Open VS Code
2. Press `Ctrl+Shift+X` (or `Cmd+Shift+X` on Mac) to open Extensions
3. Search for **"GitShift"**
4. Click **Install**

**Or install via command line:**

```bash
code --install-extension mikeeeyy04.gitshift
```

### From VSIX File

1. Download the `.vsix` file from the [Releases](https://github.com/mikeeeyy04/GitShift/releases) page
2. In VS Code, go to Extensions view (`Ctrl+Shift+X`)
3. Click the `...` menu (top right)
4. Select **"Install from VSIX..."**
5. Navigate to and select the downloaded `.vsix` file

## Quick Start

### Method 1: Sign In with GitHub (Recommended)

1. Open a Git repository in VS Code
2. Click the **GitShift** icon in the Activity Bar (left sidebar)
3. Click **"Sign In with GitHub"**
4. Authorize VS Code when prompted
5. Your account is added automatically with full authentication!
6. Switch to it and start pushing immediately 🚀

### Method 2: Manual Setup with Personal Access Token

1. Create a GitHub Personal Access Token with `repo`, `user:email`, `read:user`, and `workflow` scopes
2. Open a Git repository in VS Code
3. Click the GitShift icon in the Activity Bar
4. Click **"Add/Replace GitHub Token"**
5. Paste your token
6. Your account is automatically added and ready to use!

### Method 3: Manual Configuration File

1. Open a Git repository in VS Code
2. Create a `.vscode/github-accounts.json` file in your workspace root
3. Add your GitHub accounts:

```json
[
  {
    "label": "Work Account",
    "name": "John Doe (Work)",
    "email": "john.doe@company.com"
  },
  {
    "label": "Personal Account",
    "name": "John Doe",
    "email": "john.personal@gmail.com"
  }
]
```

## Usage

### Switching Accounts

**Method 1: Sidebar Panel (Recommended)**

- Click the GitShift icon in the Activity Bar
- Click on any account in the list to switch instantly
- Current account is highlighted with a checkmark

**Method 2: Command Palette**

1. Press `Ctrl+Shift+P` (or `Cmd+Shift+P` on Mac)
2. Type **"GitHub: Switch Account"**
3. Select your desired account from the list

**Method 3: Status Bar**

- Click on the account name in the status bar (bottom left)
- Select your desired account from the list

### Viewing Current Account

- **Sidebar**: Open the GitShift sidebar to see the current account highlighted
- **Status Bar**: Your current account is always displayed in the status bar
- **Command**: Run "GitHub: Show Active Account" from the Command Palette

### Managing Accounts

- **Add Account**: Click "Sign In with GitHub" or "Add/Replace GitHub Token"
- **Delete Account**: Click the trash icon next to an account in the sidebar
- **Edit Account**: Edit the `.vscode/github-accounts.json` file directly

## Configuration

### Account Structure

Each account in `.vscode/github-accounts.json` must have:

- `label` (required): Display name shown in the picker (e.g., "Work Account")
- `name` (required): Full name for git commits (e.g., "John Doe (Work)")
- `email` (required): Email address for git commits (e.g., "john.doe@company.com")
- `username` (optional): GitHub username (added automatically when signing in)
- `authenticated` (optional): Whether the account has authentication enabled

### Example Configuration

```json
[
  {
    "label": "Work Account",
    "name": "Alice Smith",
    "email": "alice@company.com",
    "username": "alice-company",
    "authenticated": true
  },
  {
    "label": "Personal Account",
    "name": "Alice Smith",
    "email": "alice@personal.com",
    "username": "alice-personal",
    "authenticated": true
  },
  {
    "label": "Open Source",
    "name": "Alice Smith (OSS)",
    "email": "alice@opensource.dev"
  }
]
```

### Workspace vs Global

- **Workspace Configuration**: Accounts in `.vscode/github-accounts.json` are workspace-specific
- **Global Tokens**: GitHub tokens are stored securely and accessible across all workspaces
- **Auto-Import**: The extension automatically imports tokens from other workspaces

## Commands

This extension provides the following commands (accessible via `Ctrl+Shift+P`). Search for "GitShift" to see all commands:

### Account Management

- **`GitShift: Sign In with GitHub`** - Sign in with a real GitHub account (full authentication)
- **`GitShift: Switch Account`** - Opens the account picker to switch accounts
- **`GitShift: Show Active Account`** - Displays your current Git identity
- **`GitShift: Import Active Session from VS Code`** - Import existing GitHub sessions
- **`GitShift: Add/Replace GitHub Token`** - Add or replace a Personal Access Token
- **`GitShift: Remove GitHub Token`** - Remove token from an account
- **`GitShift: Link to GitHub`** - Link an existing manual account to GitHub authentication
- **`GitShift: Open Configuration File`** - Opens the `.vscode/github-accounts.json` file

### Repository Operations

- **`GitShift: Repository Quick Clone & Switch`** - Clone a repository and switch to appropriate account
- **`GitShift: Clone Repository...`** - Clone a Git repository
- **`GitShift: Initialize Repository`** - Initialize a new Git repository in the current workspace

### Git Operations

- **`GitShift: Pull`** - Pull changes from remote
- **`GitShift: Push`** - Push changes to remote
- **`GitShift: Sync`** - Sync with remote (fetch + merge)
- **`GitShift: Fetch`** - Fetch changes from remote
- **`GitShift: Pull (Rebase)`** - Pull with rebase
- **`GitShift: Push (Force)`** - Force push to remote (use with caution)
- **`GitShift: Checkout to...`** - Switch to a different branch
- **`GitShift: Create Branch...`** - Create a new branch
- **`GitShift: Delete Branch...`** - Delete a branch
- **`GitShift: Merge Branch...`** - Merge a branch into current branch
- **`GitShift: Rebase Branch...`** - Rebase current branch onto another branch
- **`GitShift: Stash Changes`** - Stash current changes
- **`GitShift: Pop Stash`** - Apply the most recent stash
- **`GitShift: View Stashes`** - View all stashes
- **`GitShift: Discard All Changes`** - Discard all uncommitted changes
- **`GitShift: Amend Last Commit`** - Amend the last commit
- **`GitShift: Undo Last Commit`** - Undo the last commit (keeps changes staged)

### Remote Management

- **`GitShift: Add Remote...`** - Add a new remote repository
- **`GitShift: Remove Remote...`** - Remove a remote repository
- **`GitShift: View Remotes`** - View all configured remotes

### UI & Views

- **`GitShift: Refresh Sidebar`** - Refresh the GitShift sidebar
- **`GitShift: Refresh`** - Refresh the current view
- **`GitShift: More Actions...`** - Show additional Git operations menu
- **`GitShift: Open GitHub Profile`** - Open your current account's GitHub profile in browser
- **`GitShift: Refresh Contributions`** - Refresh the contributions graph
- **`GitShift: Show Git Output`** - Show Git command output channel

## UI Overview

### Sidebar Panel

- **Activity Bar Icon**: Click the account icon in the left sidebar
- **Account List**: See all your accounts with visual indicators
- **Current Account**: Highlighted with a checkmark and badge
- **Quick Actions**: Switch, add, or delete accounts directly from the sidebar

### Repository View

- **Changes Tab**: View staged and unstaged changes
- **Branches Tab**: See all local and remote branches
- **Commits Tab**: Browse recent commit history
- **Quick Actions**: Pull, push, sync, and more Git operations

### Contributions View

- **GitHub Contributions Graph**: Visualize your contribution calendar
- **Profile Information**: See your GitHub profile and stats
- **Public & Private Repos**: View contributions from both (with proper scopes)

## How It Works

### Authenticated Accounts

When you sign in with GitHub, the extension:

1. Uses VS Code's built-in GitHub authentication provider
2. Fetches your GitHub username, email, and profile information
3. Stores the access token securely using VS Code's Secret Storage API
4. Configures git credentials automatically for push/pull operations
5. Sets your git user.name and user.email for the current workspace
6. You can push/pull immediately without additional setup!

### Manual Accounts

For manual accounts, the extension sets:

```bash
git config user.name "Your Name"
git config user.email "your.email@example.com"
```

These settings are stored in `.git/config` in your workspace and only affect the current repository. Your global Git configuration remains unchanged.

**Note:** Manual accounts only set the commit author. You'll need SSH keys or Personal Access Tokens configured separately for authentication.

### Auto-Activation

The extension automatically:

- Activates the first available account when opening a workspace
- Selects an account with repository access when possible
- Validates token authenticity on startup
- Syncs account information across workspaces

## Requirements

- **VS Code**: Version 1.90.0 or higher
- **Git**: Must be installed and accessible from the command line
- **Internet Connection**: Required for GitHub authentication and API calls
- **GitHub Account**: Required for authenticated features

## Troubleshooting

### Extension not working in Cursor or Antigravity

If you're using Cursor, Antigravity, or other VS Code forks and git operations are failing after account switching:

1. The extension now includes enhanced compatibility mode that automatically detects VS Code forks
2. Check the GitShift output channel (View → Output → GitShift) to confirm detection
3. Git operations now use `GIT_TERMINAL_PROMPT=0` to prevent interactive prompts that can hang in forks
4. Credential configuration falls back to global config if local config fails
5. If issues persist, try manually running: `git config --global credential.helper store`

### "Not in a Git repository" error

Make sure you have a Git repository initialized in your workspace:

```bash
git init
```

### Accounts not showing up

1. Verify `.vscode/github-accounts.json` exists in your workspace root
2. Check that the JSON is valid (use a JSON validator)
3. Ensure each account has `label`, `name`, and `email` fields
4. Try refreshing the sidebar or reloading the window (`Ctrl+R` or `Cmd+R`)

### Status bar not updating

1. Try running the **"GitHub: Show Active Account"** command
2. Reload the VS Code window (`Ctrl+R` or `Cmd+R`)
3. Check if you're in a Git repository

### Git commands failing

1. Verify Git is installed: `git --version`
2. Ensure Git is in your system PATH
3. Check workspace folder permissions
4. For authenticated accounts, verify your token has the correct scopes (`repo`, `user:email`, `read:user`, `workflow`)

### Token authentication issues

1. Verify your token has the required scopes:
   - `repo` - Full control of private repositories
   - `user:email` - Access user email addresses
   - `read:user` - Read user profile data
   - `workflow` - Update GitHub Action workflows
   - `notifications` - Access notifications (optional)
2. Try removing and re-adding the token
3. Check if the token has expired

### Extension not activating

1. Check VS Code version (requires 1.90.0+)
2. Open the Output panel and select "GitShift" from the dropdown
3. Check for error messages
4. Reload the window: `Ctrl+R` (or `Cmd+R` on Mac)

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

We have a comprehensive [Contributing Guide](CONTRIBUTING.md) that covers:

- How to set up your development environment
- Coding standards and best practices
- How to submit bug reports and feature requests
- The pull request process

**Quick Start:**

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/AmazingFeature`)
3. Make your changes and test them
4. Commit your changes following our [commit guidelines](CONTRIBUTING.md#commit-guidelines)
5. Push to the branch (`git push origin feature/AmazingFeature`)
6. Open a Pull Request

Please read [CONTRIBUTING.md](CONTRIBUTING.md) for complete details.

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

The MIT License allows commercial use, modification, and distribution. Please maintain proper attribution when using this code. See [LICENSE](LICENSE) for full details.

## Support the Project

If you find **GitShift** helpful and want to support its development, consider buying me a coffee!

<a href="https://www.buymeacoffee.com/mikeeeyy" target="_blank">
  <img src="https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png" alt="Buy Me A Coffee" height="50" />
</a>

Your support helps keep this project maintained and improved! 💖

## Feedback & Issues

Found a bug or have a feature request? Please [open an issue](https://github.com/mikeeeyy04/GitShift/issues) on GitHub.

## Credits

Developed to solve the common problem of managing multiple GitHub identities in VS Code.

---

<div align="center">

**Enjoy seamless GitHub account switching!** 🚀

[![Buy Me A Coffee](https://img.shields.io/badge/Buy%20Me%20A%20Coffee-Support%20GitShift-yellow.svg?style=for-the-badge&logo=buy-me-a-coffee)](https://www.buymeacoffee.com/mikeeeyy)

Made with ❤️ for the developer community

</div>
