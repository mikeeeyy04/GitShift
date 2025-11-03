/**
 * GitShift - VS Code Extension
 * Copyright (c) 2025 mikeeeyy04
 * https://github.com/mikeeeyy04/GitShift
 * 
 * MIT License - See LICENSE file for details
 */

import * as vscode from 'vscode';
import { getCurrentGitUser, setGitUser, isGitRepository, getGitRemoteUrl } from './gitManager';
import { loadAccounts, createDefaultAccountsFile, accountsFileExists, saveAccounts } from './accountManager';
import { createStatusBarItem, updateStatusBar } from './statusBar';
import { createAccountTreeView } from './accountTreeView';
import { SidebarProvider } from './sidebarWebview';
import { RepositoryProvider } from './repositoryWebview';
import { ContributionsProvider } from './contributionsWebview';
import { SupportProvider } from './supportWebview';
import { GitHubAccount } from './types';
import { signInToGitHub, getGitHubUser, getGitHubEmails, getGitHubSessions, getGitHubSessionByAccountId, initAuthSecrets, validateGitHubToken, storeGitHubToken, deleteGitHubToken, getGitHubToken, checkRepoAccess, checkCollaboratorAccess, getAllStoredTokens, createGitHubRepository } from './githubAuth';
import { quickCloneRepository } from './repoQuickClone';
import { configureGitCredentials, updateRemoteUrlWithToken, getRemoteUrl, parseGitHubUrl } from './gitCredentials';

// Global instances
let treeProvider: any;
let sidebarProvider: SidebarProvider;
let repositoryProvider: RepositoryProvider;
let contributionsProvider: ContributionsProvider;
let supportProvider: SupportProvider;
let extensionContext: vscode.ExtensionContext;
let gitshiftOutputChannel: vscode.OutputChannel;

/**
 * Activates the extension
 */
export async function activate(context: vscode.ExtensionContext) {
  // Create output channel for GitShift
  gitshiftOutputChannel = vscode.window.createOutputChannel('GitShift');
  gitshiftOutputChannel.appendLine('GitShift is now active');


  // Store context globally for secret storage access
  extensionContext = context;
  // Initialize token vault access
  initAuthSecrets(context);

  // Create tree view for sidebar
  treeProvider = createAccountTreeView(context);

  // Register sidebar webview
  sidebarProvider = new SidebarProvider(context.extensionUri);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('githubAccountsWebview', sidebarProvider)
  );

  // Validate authentication states when sidebar is first viewed
  setTimeout(() => {
    validateAccountAuthenticationStates().catch(() => {
      // Silent failure
    });
  }, 1000); // Give extension time to initialize

  // Register repository webview (consolidated Changes, Branches, and Commits)
  repositoryProvider = new RepositoryProvider(context.extensionUri);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('repositoryWebview', repositoryProvider),
    repositoryProvider  // Add provider itself for disposal
  );

  // Start file watcher for repository webview (works even when webview is not visible)
  repositoryProvider.startFileWatcher();

  // Restart file watcher when workspace folders change
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(async () => {
      repositoryProvider.startFileWatcher();
      // Auto-activate first account if no repo
      await autoActivateFirstAccountIfNeeded();
    })
  );

  // Auto-activate first account on activation if no repo
  setTimeout(async () => {
    await autoActivateFirstAccountIfNeeded();
  }, 2000); // Give extension time to initialize

  // Register contributions webview
  contributionsProvider = new ContributionsProvider(context.extensionUri);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('contributionsWebview', contributionsProvider)
  );

  // Register support webview
  supportProvider = new SupportProvider(context.extensionUri);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('supportWebview', supportProvider)
  );

  // Create status bar item
  createStatusBarItem(context);

  // Check if we're in a git repository (non-blocking)
  isGitRepository().then(isGitRepo => {
    if (isGitRepo) {
      updateStatusBar().catch(() => {
        // Silent failure - status bar will update on next action
      });
    }
  }).catch(() => {
    // Silent failure - repository check will retry on workspace change
  });

  // Register switch account command
  const switchAccountCommand = vscode.commands.registerCommand(
    'gitshift.switchAccount',
    async () => {
      await handleSwitchAccount();
    }
  );

  // Register show active account command
  const showActiveAccountCommand = vscode.commands.registerCommand(
    'gitshift.showActiveAccount',
    async () => {
      await handleShowActiveAccount();
    }
  );

  // Register switch to specific account command (for tree view clicks)
  const switchToAccountCommand = vscode.commands.registerCommand(
    'gitshift.switchToAccount',
    async (account: GitHubAccount) => {
      await handleSwitchToAccount(account);
    }
  );

  // Register refresh sidebar command
  const refreshSidebarCommand = vscode.commands.registerCommand(
    'gitshift.refreshSidebar',
    () => {
      if (sidebarProvider) {
        sidebarProvider.refresh();
      }
    }
  );

  // Register refresh tree view command
  const refreshTreeViewCommand = vscode.commands.registerCommand(
    'gitshift.refreshTreeView',
    () => {
      treeProvider.refresh();
    }
  );

  // Register open config command
  const openConfigCommand = vscode.commands.registerCommand(
    'gitshift.openConfig',
    async () => {
      await handleOpenConfig();
    }
  );

  // Register sign in with GitHub command
  const signInWithGitHubCommand = vscode.commands.registerCommand(
    'gitshift.signInWithGitHub',
    async () => {
      await handleSignInWithGitHub();
    }
  );

  // Register link account command
  const linkAccountCommand = vscode.commands.registerCommand(
    'gitshift.linkAccount',
    async (account: GitHubAccount) => {
      await handleLinkAccount(account);
    }
  );

  // Register delete account token command (internal)
  const deleteAccountTokenCommand = vscode.commands.registerCommand(
    'gitshift.deleteAccountToken',
    async (username: string) => {
      await extensionContext.secrets.delete(`github-token-${username}`);
    }
  );

  // Register manual import command (supports multiple accounts)
  const importAccountsCommand = vscode.commands.registerCommand(
    'gitshift.importAccounts',
    async () => {
      try {
        // First, import the current active session from VS Code
        const workspaceId = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || 'no-workspace';
        await extensionContext.workspaceState.update(`hasAutoImported-${workspaceId}`, false);

        // Get current sessions
        const sessions = await getGitHubSessions();
        const hadSession = sessions.length > 0;

        await autoImportGitHubAccounts();

        // Show info about what was imported
        if (sessions.length === 0) {
          const choice = await vscode.window.showInformationMessage(
            'No active GitHub session found in VS Code. Would you like to sign in to import accounts?',
            'Sign In',
            'Add PAT Token Instead',
            'Cancel'
          );

          if (choice === 'Sign In') {
            // Continue with sign-in flow below
          } else if (choice === 'Add PAT Token Instead') {
            await vscode.commands.executeCommand('gitshift.addToken');
            return;
          } else {
            return;
          }
        } else if (hadSession) {
          vscode.window.showInformationMessage(
            `Imported current active GitHub session! To add more accounts, click "Add Another" below.`
          );
        }

        // Then allow the user to add additional accounts interactively
        // by forcing new sessions repeatedly until they choose Done
        let imported = 0;
        // eslint-disable-next-line no-constant-condition
        while (true) {
          const choice = await vscode.window.showInformationMessage(
            imported === 0
              ? 'Import additional GitHub accounts?'
              : 'Import another GitHub account?',
            'Add Another',
            'Done'
          );
          if (choice !== 'Add Another') {
            break;
          }

          // Force a new session so user can pick a different account
          const session = await signInToGitHub(true);
          if (!session) {
            // User cancelled sign-in; ask if they want to continue adding more
            const cont = await vscode.window.showInformationMessage(
              'Sign-in cancelled. Do you want to continue importing?',
              'Continue',
              'Stop'
            );
            if (cont !== 'Continue') break;
            continue;
          }

          try {
            const user = await getGitHubUser(session.accessToken);
            const emails = await getGitHubEmails(session.accessToken);
            // Get primary email or first verified email, fallback to user.email from API
            const primaryEmail = emails.find(e => e.primary && e.verified)?.email ||
              emails.find(e => e.verified)?.email ||
              emails.find(e => e.primary)?.email ||
              emails[0]?.email ||
              user.email;

            if (!primaryEmail) {
              throw new Error('Unable to retrieve email address. Please ensure your token has the "user:email" scope enabled.');
            }

            const accounts = await loadAccounts();
            const existsIdx = accounts.findIndex(a => a.username === user.login || a.email === primaryEmail);

            if (existsIdx >= 0) {
              // Always update email with fresh data from GitHub API when importing
              accounts[existsIdx] = {
                ...accounts[existsIdx],
                label: `${user.login}`,
                name: user.name || user.login,
                email: primaryEmail,
                sessionId: session.id,
                accountId: session.account.id,
                username: user.login,
                avatarUrl: user.avatar_url,
                authenticated: true
              };
            } else {
              accounts.push({
                label: `${user.login}`,
                name: user.name || user.login,
                email: primaryEmail,
                sessionId: session.id,
                accountId: session.account.id,
                username: user.login,
                avatarUrl: user.avatar_url,
                authenticated: true
              });
            }

            // Store token for this username (also registers in global registry)
            await storeGitHubToken(user.login, session.accessToken);
            await saveAccounts(accounts);
            imported++;

            // Refresh UI after each import
            if (treeProvider) treeProvider.refresh();
            if (sidebarProvider) sidebarProvider.refresh();

            vscode.window.showInformationMessage(`Imported ${user.login}.`);
          } catch (err: any) {
            vscode.window.showErrorMessage(`Failed to import account: ${err.message}`);
          }
        }

        if (imported > 0) {
          vscode.window.showInformationMessage(`Finished importing ${imported} account${imported > 1 ? 's' : ''}.`);
        }

        // Auto-activate first account if none is active after import
        const isGitRepo = await isGitRepository();
        if (isGitRepo) {
          await autoActivateFirstAccount().catch(() => {
            // Silent failure
          });
        } else {
          await autoActivateFirstAccountIfNeeded().catch(() => {
            // Silent failure
          });
        }
      } catch (e: any) {
        vscode.window.showErrorMessage(`Import failed: ${e.message}`);
      }
    }
  );

  // Register add/replace token command
  const addTokenCommand = vscode.commands.registerCommand(
    'gitshift.addToken',
    async (_accountArg?: GitHubAccount) => {
      try {
        const token = await vscode.window.showInputBox({
          prompt: 'Paste a GitHub Personal Access Token (PAT) with repo scope',
          ignoreFocusOut: true,
          password: true
        });
        if (!token) return;

        // Validate token -> gets user and scopes
        const { user, scopes } = await validateGitHubToken(token);
        if (scopes.length === 0 || !scopes.some(s => s.toLowerCase() === 'repo')) {
          const proceed = await vscode.window.showWarningMessage(
            'Token appears to be missing repo scope. Continue anyway?',
            'Continue'
          );
          if (proceed !== 'Continue') return;
        }

        // Store token under username
        await storeGitHubToken(user.login, token);

        // Upsert account entry
        const accounts = await loadAccounts();
        const emails = await getGitHubEmails(token);
        // Get primary email or first verified email, fallback to user.email from API
        const primaryEmail = emails.find(e => e.primary && e.verified)?.email ||
          emails.find(e => e.verified)?.email ||
          emails.find(e => e.primary)?.email ||
          emails[0]?.email ||
          user.email;

        if (!primaryEmail) {
          throw new Error('Unable to retrieve email address. Please ensure your token has the "user:email" scope enabled.');
        }

        const idx = accounts.findIndex(a => a.username === user.login);
        if (idx >= 0) {
          // Always update email with fresh data from GitHub API when adding/replacing token
          accounts[idx] = { ...accounts[idx], username: user.login, name: user.name || user.login, email: primaryEmail, authenticated: true, avatarUrl: user.avatar_url };
        } else {
          accounts.push({
            label: `${user.login}`,
            name: user.name || user.login,
            email: primaryEmail,
            sessionId: '',
            accountId: '',
            username: user.login,
            avatarUrl: user.avatar_url,
            authenticated: true
          });
        }
        await saveAccounts(accounts);

        vscode.window.showInformationMessage(`Token saved for ${user.login}.`);
        if (treeProvider) treeProvider.refresh();
        if (sidebarProvider) sidebarProvider.refresh();

        // Auto-activate this account if none is currently active
        const isGitRepo = await isGitRepository();
        if (isGitRepo) {
          await autoActivateFirstAccount().catch(() => {
            // Silent failure
          });
        } else {
          await autoActivateFirstAccountIfNeeded().catch(() => {
            // Silent failure
          });
        }
      } catch (e: any) {
        vscode.window.showErrorMessage(`Failed to save token: ${e.message}`);
      }
    }
  );

  // Register remove token command
  const removeTokenCommand = vscode.commands.registerCommand(
    'gitshift.removeToken',
    async (usernameArg?: string) => {
      try {
        const accounts = await loadAccounts();
        let username = usernameArg;
        if (!username) {
          if (accounts.length === 0) {
            vscode.window.showInformationMessage('No accounts to remove token from.');
            return;
          }
          const pick = await vscode.window.showQuickPick(accounts.map(a => ({ label: a.label, description: a.username || a.email, account: a })), { placeHolder: 'Select account to remove token' });
          if (!pick) return;
          username = pick.account.username;
        }
        if (!username) {
          vscode.window.showWarningMessage('Selected account has no associated GitHub username.');
          return;
        }
        await deleteGitHubToken(username);
        // Mark unauthenticated
        const idx = accounts.findIndex(a => a.username === username);
        if (idx >= 0) {
          accounts[idx].authenticated = false;
          await saveAccounts(accounts);
        }
        vscode.window.showInformationMessage(`Token removed for ${username}.`);
        if (treeProvider) treeProvider.refresh();
        if (sidebarProvider) sidebarProvider.refresh();
      } catch (e: any) {
        vscode.window.showErrorMessage(`Failed to remove token: ${e.message}`);
      }
    }
  );

  // Register quick clone command
  const quickCloneCommand = vscode.commands.registerCommand(
    'gitshift.quickCloneRepo',
    async () => {
      try {
        await quickCloneRepository(context);
      } catch (error: any) {
        vscode.window.showErrorMessage(`Failed to clone repository: ${error?.message || error || 'Unknown error'}`);
        console.error('Quick clone error:', error);
      }
    }
  );

  // Register git operation commands
  const pullCommand = vscode.commands.registerCommand('gitshift.pull', async () => {
    await handleGitOperation('pull', async () => {
      const { pull } = await import('./gitOperations');
      await pull();
      vscode.window.showInformationMessage('Pulled from remote');
      if (repositoryProvider) await repositoryProvider.refresh();
    });
  });

  const pushCommand = vscode.commands.registerCommand('gitshift.push', async () => {
    await handleGitOperation('push', async () => {
      const { push } = await import('./gitOperations');
      await push();
      vscode.window.showInformationMessage('Pushed to remote');
      if (repositoryProvider) await repositoryProvider.refresh();
    });
  });

  const syncCommand = vscode.commands.registerCommand('gitshift.sync', async () => {
    await handleGitOperation('sync', async () => {
      const { sync } = await import('./gitOperations');
      await sync();
      vscode.window.showInformationMessage('Synced with remote');
      if (repositoryProvider) await repositoryProvider.refresh();
    });
  });

  const fetchCommand = vscode.commands.registerCommand('gitshift.fetch', async () => {
    await handleGitOperation('fetch', async () => {
      const { fetch } = await import('./gitOperations');
      await fetch();
      vscode.window.showInformationMessage('Fetched from remote');
      if (repositoryProvider) await repositoryProvider.refresh();
    });
  });

  const refreshChangesCommand = vscode.commands.registerCommand('gitshift.refreshChanges', async () => {
    if (repositoryProvider) {
      await repositoryProvider.refresh();
      vscode.window.showInformationMessage('Refreshed repository');
    }
  });

  const moreActionsCommand = vscode.commands.registerCommand('gitshift.moreActions', async () => {
    const actions = [
      { label: '$(cloud-download) Clone Repository...', command: 'gitshift.clone' },
      { label: '$(git-branch) Checkout to...', command: 'gitshift.checkout' },
      { label: '$(archive) Stash Changes', command: 'gitshift.stash' },
      { label: '$(archive) Pop Stash', command: 'gitshift.stashPop' },
      { label: '$(list-unordered) View Stashes', command: 'gitshift.viewStashes' },
      { label: '$(git-branch) Create Branch...', command: 'gitshift.createBranch' },
      { label: '$(trash) Delete Branch...', command: 'gitshift.deleteBranch' },
      { label: '$(git-merge) Merge Branch...', command: 'gitshift.mergeBranch' },
      { label: '$(git-compare) Rebase Branch...', command: 'gitshift.rebaseBranch' },
      { label: '$(arrow-down) Pull (Rebase)', command: 'gitshift.pullRebase' },
      { label: '$(arrow-up) Push (Force)', command: 'gitshift.pushForce' },
      { label: '$(discard) Discard All Changes', command: 'gitshift.discardAllChanges' },
      { label: '$(edit) Amend Last Commit', command: 'gitshift.amendCommit' },
      { label: '$(discard) Undo Last Commit', command: 'gitshift.undoLastCommit' },
      { label: '$(plug) Add Remote...', command: 'gitshift.addRemote' },
      { label: '$(trash) Remove Remote...', command: 'gitshift.removeRemote' },
      { label: '$(list-unordered) View Remotes', command: 'gitshift.viewRemotes' },
      { label: '$(output) Show Git Output', command: 'gitshift.showGitOutput' },
      { label: '$(repo) Initialize Repository', command: 'gitshift.initRepo' }
    ];

    const selected = await vscode.window.showQuickPick(actions, {
      placeHolder: 'Select a Git action'
    });

    if (selected) {
      await vscode.commands.executeCommand(selected.command);
    }
  });

  const cloneCommand = vscode.commands.registerCommand('gitshift.clone', async () => {
    const url = await vscode.window.showInputBox({
      prompt: 'Enter repository URL to clone',
      placeHolder: 'https://github.com/user/repo.git'
    });
    if (!url) return;

    const uri = await vscode.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      openLabel: 'Select Clone Location'
    });
    if (!uri || uri.length === 0) return;

    const dirName = await vscode.window.showInputBox({
      prompt: 'Enter directory name',
      value: url.split('/').pop()?.replace('.git', '') || 'repo'
    });
    if (!dirName) return;

    await handleGitOperation('clone', async () => {
      const { cloneRepository } = await import('./gitOperations');
      await cloneRepository(url, `${uri[0].fsPath}/${dirName}`);
      vscode.window.showInformationMessage(`Cloned repository to ${dirName}`);
    });
  });

  const checkoutCommand = vscode.commands.registerCommand('gitshift.checkout', async () => {
    await handleGitOperation('checkout', async () => {
      const { getBranches, checkoutBranch } = await import('./gitOperations');
      const branches = await getBranches();
      const items = branches.map(b => ({
        label: b.current ? `$(check) ${b.name}` : b.name,
        description: b.remote ? 'remote' : 'local',
        branch: b
      }));

      const selected = await vscode.window.showQuickPick(items, {
        placeHolder: 'Select a branch to checkout'
      });

      if (selected) {
        await checkoutBranch(selected.branch.name);
        vscode.window.showInformationMessage(`Checked out to ${selected.branch.name}`);
        if (repositoryProvider) await repositoryProvider.refresh();
        // Branches are now part of repositoryProvider
      }
    });
  });

  const stashCommand = vscode.commands.registerCommand('gitshift.stash', async () => {
    const message = await vscode.window.showInputBox({
      prompt: 'Enter stash message (optional)',
      placeHolder: 'WIP: feature description'
    });

    await handleGitOperation('stash', async () => {
      const { stash } = await import('./gitOperations');
      await stash(message);
      vscode.window.showInformationMessage('Changes stashed');
      if (repositoryProvider) await repositoryProvider.refresh();
    });
  });

  const stashPopCommand = vscode.commands.registerCommand('gitshift.stashPop', async () => {
    await handleGitOperation('stash pop', async () => {
      const { stashPop } = await import('./gitOperations');
      await stashPop();
      vscode.window.showInformationMessage('Stash applied');
      if (repositoryProvider) await repositoryProvider.refresh();
    });
  });

  const viewStashesCommand = vscode.commands.registerCommand('gitshift.viewStashes', async () => {
    await handleGitOperation('view stashes', async () => {
      const { getStashes } = await import('./gitOperations');
      const stashes = await getStashes();
      if (stashes.length === 0) {
        vscode.window.showInformationMessage('No stashes found');
        return;
      }

      const selected = await vscode.window.showQuickPick(stashes, {
        placeHolder: 'Stash list (select to view details)'
      });

      if (selected) {
        vscode.window.showInformationMessage(selected);
      }
    });
  });

  const createBranchCommand = vscode.commands.registerCommand('gitshift.createBranch', async () => {
    const branchName = await vscode.window.showInputBox({
      prompt: 'Enter new branch name',
      placeHolder: 'feature/new-feature'
    });
    if (!branchName) return;

    await handleGitOperation('create branch', async () => {
      const { createBranch, checkoutBranch } = await import('./gitOperations');
      await createBranch(branchName);
      const shouldCheckout = await vscode.window.showQuickPick(['Yes', 'No'], {
        placeHolder: 'Checkout to new branch?'
      });
      if (shouldCheckout === 'Yes') {
        await checkoutBranch(branchName);
      }
      vscode.window.showInformationMessage(`Created branch ${branchName}`);
      if (repositoryProvider) await repositoryProvider.refresh();
    });
  });

  const deleteBranchCommand = vscode.commands.registerCommand('gitshift.deleteBranch', async () => {
    await handleGitOperation('delete branch', async () => {
      const { getBranches, deleteBranch } = await import('./gitOperations');
      const branches = await getBranches();
      const items = branches.filter(b => !b.current).map(b => ({
        label: b.name,
        description: b.remote ? 'remote' : 'local',
        branch: b
      }));

      const selected = await vscode.window.showQuickPick(items, {
        placeHolder: 'Select a branch to delete'
      });

      if (selected) {
        const confirm = await vscode.window.showWarningMessage(
          `Delete branch ${selected.branch.name}?`,
          { modal: true },
          'Delete',
          'Force Delete'
        );
        if (confirm) {
          await deleteBranch(selected.branch.name, confirm === 'Force Delete');
          vscode.window.showInformationMessage(`Deleted branch ${selected.branch.name}`);
          // Branches are now part of repositoryProvider
        }
      }
    });
  });

  const mergeBranchCommand = vscode.commands.registerCommand('gitshift.mergeBranch', async () => {
    await handleGitOperation('merge branch', async () => {
      const { getBranches, mergeBranch } = await import('./gitOperations');
      const branches = await getBranches();
      const items = branches.filter(b => !b.current).map(b => ({
        label: b.name,
        description: b.remote ? 'remote' : 'local',
        branch: b
      }));

      const selected = await vscode.window.showQuickPick(items, {
        placeHolder: 'Select a branch to merge into current branch'
      });

      if (selected) {
        await mergeBranch(selected.branch.name);
        vscode.window.showInformationMessage(`Merged ${selected.branch.name}`);
        if (repositoryProvider) await repositoryProvider.refresh();
      }
    });
  });

  const rebaseBranchCommand = vscode.commands.registerCommand('gitshift.rebaseBranch', async () => {
    await handleGitOperation('rebase branch', async () => {
      const { getBranches, rebaseBranch } = await import('./gitOperations');
      const branches = await getBranches();
      const items = branches.filter(b => !b.current).map(b => ({
        label: b.name,
        description: b.remote ? 'remote' : 'local',
        branch: b
      }));

      const selected = await vscode.window.showQuickPick(items, {
        placeHolder: 'Select a branch to rebase current branch onto'
      });

      if (selected) {
        await rebaseBranch(selected.branch.name);
        vscode.window.showInformationMessage(`Rebased onto ${selected.branch.name}`);
        if (repositoryProvider) await repositoryProvider.refresh();
      }
    });
  });

  const pullRebaseCommand = vscode.commands.registerCommand('gitshift.pullRebase', async () => {
    await handleGitOperation('pull with rebase', async () => {
      const { pullRebase } = await import('./gitOperations');
      await pullRebase();
      vscode.window.showInformationMessage('Pulled with rebase');
      if (repositoryProvider) await repositoryProvider.refresh();
    });
  });

  const pushForceCommand = vscode.commands.registerCommand('gitshift.pushForce', async () => {
    const confirm = await vscode.window.showWarningMessage(
      'Force push can overwrite remote changes. Continue?',
      { modal: true },
      'Force Push'
    );
    if (confirm !== 'Force Push') return;

    await handleGitOperation('force push', async () => {
      const { pushForce } = await import('./gitOperations');
      await pushForce();
      vscode.window.showInformationMessage('Force pushed to remote');
      if (repositoryProvider) await repositoryProvider.refresh();
    });
  });

  const discardAllChangesCommand = vscode.commands.registerCommand('gitshift.discardAllChanges', async () => {
    const confirm = await vscode.window.showWarningMessage(
      'Discard all changes? This cannot be undone.',
      { modal: true },
      'Discard All'
    );
    if (confirm !== 'Discard All') return;

    await handleGitOperation('discard all changes', async () => {
      const { discardAllChanges } = await import('./gitOperations');
      await discardAllChanges();
      vscode.window.showInformationMessage('All changes discarded');
      if (repositoryProvider) await repositoryProvider.refresh();
    });
  });

  const amendCommitCommand = vscode.commands.registerCommand('gitshift.amendCommit', async () => {
    const message = await vscode.window.showInputBox({
      prompt: 'Enter new commit message (leave empty to keep current)',
      placeHolder: 'Updated commit message'
    });

    await handleGitOperation('amend commit', async () => {
      const { amendCommit } = await import('./gitOperations');
      await amendCommit(message);
      vscode.window.showInformationMessage('Commit amended');
      if (repositoryProvider) await repositoryProvider.refresh();
      // Commits are now part of repositoryProvider
    });
  });

  const undoLastCommitCommand = vscode.commands.registerCommand('gitshift.undoLastCommit', async () => {
    const confirm = await vscode.window.showWarningMessage(
      'Undo last commit? Changes will be moved back to staging.',
      { modal: true },
      'Undo'
    );
    if (confirm !== 'Undo') return;

    await handleGitOperation('undo last commit', async () => {
      const { undoLastCommit } = await import('./gitOperations');
      await undoLastCommit();
      vscode.window.showInformationMessage('Last commit undone');
      if (repositoryProvider) await repositoryProvider.refresh();
      // Commits are now part of repositoryProvider
    });
  });

  // Register open GitHub profile command
  const openGitHubProfileCommand = vscode.commands.registerCommand('gitshift.openGitHubProfile', async () => {
    try {
      const accounts = await loadAccounts();
      const currentUser = await getCurrentGitUser();

      if (!currentUser) {
        vscode.window.showWarningMessage('No active Git user found. Please configure your Git identity first.');
        return;
      }

      // Find the current account
      const currentAccount = accounts.find(acc =>
        acc.name === currentUser.name && acc.email === currentUser.email
      );

      if (!currentAccount || !currentAccount.username) {
        vscode.window.showWarningMessage('Active account does not have a GitHub username. Please link the account to GitHub first.');
        return;
      }

      // Open GitHub profile
      const profileUrl = `https://github.com/${currentAccount.username}`;
      await vscode.env.openExternal(vscode.Uri.parse(profileUrl));
    } catch (error: any) {
      vscode.window.showErrorMessage(`Failed to open GitHub profile: ${error.message}`);
    }
  });

  // Register refresh contributions command
  const refreshContributionsCommand = vscode.commands.registerCommand('gitshift.refreshContributions', async () => {
    if (contributionsProvider) {
      await contributionsProvider.refresh();
    }
  });

  const addRemoteCommand = vscode.commands.registerCommand('gitshift.addRemote', async () => {
    const name = await vscode.window.showInputBox({
      prompt: 'Enter remote name',
      value: 'origin'
    });
    if (!name) return;

    const url = await vscode.window.showInputBox({
      prompt: 'Enter remote URL',
      placeHolder: 'https://github.com/user/repo.git'
    });
    if (!url) return;

    await handleGitOperation('add remote', async () => {
      const { addRemote } = await import('./gitOperations');
      await addRemote(name, url);
      vscode.window.showInformationMessage(`Added remote ${name}`);
    });
  });

  const removeRemoteCommand = vscode.commands.registerCommand('gitshift.removeRemote', async () => {
    await handleGitOperation('remove remote', async () => {
      const { getRemotes, removeRemote } = await import('./gitOperations');
      const remotes = await getRemotes();
      if (remotes.length === 0) {
        vscode.window.showInformationMessage('No remotes found');
        return;
      }

      const items = remotes.map(r => {
        const parts = r.split(/\s+/);
        return { label: parts[0], description: parts[1] };
      });

      const selected = await vscode.window.showQuickPick(items, {
        placeHolder: 'Select a remote to remove'
      });

      if (selected) {
        const confirm = await vscode.window.showWarningMessage(
          `Remove remote ${selected.label}?`,
          { modal: true },
          'Remove'
        );
        if (confirm === 'Remove') {
          await removeRemote(selected.label);
          vscode.window.showInformationMessage(`Removed remote ${selected.label}`);
        }
      }
    });
  });

  const viewRemotesCommand = vscode.commands.registerCommand('gitshift.viewRemotes', async () => {
    await handleGitOperation('view remotes', async () => {
      const { getRemotes } = await import('./gitOperations');
      const remotes = await getRemotes();
      if (remotes.length === 0) {
        vscode.window.showInformationMessage('No remotes configured');
        return;
      }

      const formatted = remotes.join('\n');
      vscode.window.showInformationMessage(`Remotes:\n\n${formatted}`, { modal: false });
    });
  });

  const showGitOutputCommand = vscode.commands.registerCommand('gitshift.showGitOutput', async () => {
    const outputChannel = vscode.window.createOutputChannel('Git');
    outputChannel.show();
    outputChannel.appendLine('Git output channel opened');
    outputChannel.appendLine('Run Git commands to see output here');
  });

  const initRepoCommand = vscode.commands.registerCommand('gitshift.initRepo', async () => {
    gitshiftOutputChannel?.appendLine('[initRepo] Command invoked');
    gitshiftOutputChannel?.appendLine(`[initRepo] Stack trace: ${new Error().stack}`);

    try {
      // Check if already in a git repository
      const isGitRepo = await isGitRepository();
      if (isGitRepo) {
        gitshiftOutputChannel?.appendLine('[initRepo] Already in a Git repository');
        vscode.window.showInformationMessage('This folder is already a Git repository');
        return;
      }

      gitshiftOutputChannel?.appendLine('[initRepo] Showing confirmation dialog...');
      // Use showWarningMessage with modal to ensure it doesn't auto-dismiss
      const confirm = await vscode.window.showWarningMessage(
        'Initialize a Git repository in the current workspace?',
        { modal: true },
        'Initialize'
      );
      gitshiftOutputChannel?.appendLine(`[initRepo] User response: ${confirm} (type: ${typeof confirm})`);

      if (!confirm || confirm !== 'Initialize') {
        gitshiftOutputChannel?.appendLine(`[initRepo] User cancelled or dismissed dialog. Response was: ${confirm}`);
        return;
      }

      gitshiftOutputChannel?.appendLine('[initRepo] User confirmed, proceeding...');
      await handleGitOperation('initialize repository', async () => {
        gitshiftOutputChannel?.appendLine('[initRepo] Starting repository initialization...');
        const { initRepository } = await import('./gitOperations');
        await initRepository();
        gitshiftOutputChannel?.appendLine('[initRepo] Repository initialized successfully');
        vscode.window.showInformationMessage('Repository initialized');
        if (repositoryProvider) await repositoryProvider.refresh();
        // Add small delay to ensure Git repository is detected
        setTimeout(async () => {
          if (sidebarProvider) await sidebarProvider.refresh(true);
        }, 200);
      });
    } catch (error: any) {
      gitshiftOutputChannel?.appendLine(`[initRepo] ERROR: ${error.message || 'Unknown error'}`);
      gitshiftOutputChannel?.appendLine(`[initRepo] ERROR Stack: ${error.stack || 'No stack trace'}`);
      gitshiftOutputChannel?.show(true);
      throw error;
    }
  });

  const publishToGitHubCommand = vscode.commands.registerCommand('gitshift.publishToGitHub', async () => {
    gitshiftOutputChannel?.appendLine('[publishToGitHub] Command invoked');
    try {
      // Get workspace folder name for default repo name
      const workspaceFolders = vscode.workspace.workspaceFolders;
      if (!workspaceFolders || workspaceFolders.length === 0) {
        vscode.window.showErrorMessage('No workspace folder open');
        return;
      }

      const workspaceName = workspaceFolders[0].name;
      const defaultRepoName = workspaceName.replace(/[^a-zA-Z0-9._-]/g, '-').toLowerCase();
      gitshiftOutputChannel?.appendLine(`[publishToGitHub] Default repo name: ${defaultRepoName}`);

      // Get repository name first - show this directly without checking for repo
      const repoName = await vscode.window.showInputBox({
        prompt: 'Repository Name',
        value: defaultRepoName,
        validateInput: (value) => {
          if (!value || value.trim().length === 0) {
            return 'Repository name cannot be empty';
          }
          if (!/^[a-zA-Z0-9._-]+$/.test(value)) {
            return 'Repository name can only contain letters, numbers, dots, underscores, and hyphens';
          }
          return null;
        }
      });

      gitshiftOutputChannel?.appendLine(`[publishToGitHub] Repository name: ${repoName || 'cancelled'}`);
      if (!repoName) {
        gitshiftOutputChannel?.appendLine('[publishToGitHub] User cancelled repository name input');
        return;
      }

      // Get GitHub username first (needed for displaying full path)
      // We'll try to get it early, but may update after account selection
      let githubUsername = 'your-username';
      const accounts = await loadAccounts();
      const currentUser = await getCurrentGitUser();
      let account: GitHubAccount | undefined;

      if (currentUser) {
        account = accounts.find(acc => acc.name === currentUser.name && acc.email === currentUser.email);
      }

      if (account && account.username) {
        githubUsername = account.username;
      } else {
        // Try to get username from first available authenticated account
        if (accounts.length > 0) {
          for (const acc of accounts) {
            if (acc.username && acc.authenticated) {
              try {
                const token = await getGitHubToken(acc.username);
                if (token) {
                  const user = await getGitHubUser(token);
                  githubUsername = user.login;
                  break;
                }
              } catch (e) {
                // Continue to next account
              }
            }
          }
          // If still no username, use first account's username
          if (githubUsername === 'your-username' && accounts.length > 0 && accounts[0].username) {
            githubUsername = accounts[0].username;
          }
        }
      }

      // Ask for visibility with full path display
      const visibility = await vscode.window.showQuickPick(
        [
          {
            label: '$(repo) Publish to GitHub private repository $(github)',
            description: `${githubUsername}/${repoName}`,
            detail: 'Only you can see this repository',
            isPrivate: true
          },
          {
            label: '$(repo) Publish to GitHub public repository $(github)',
            description: `${githubUsername}/${repoName}`,
            detail: 'Anyone can see this repository',
            isPrivate: false
          }
        ],
        {
          placeHolder: 'Select repository visibility'
        }
      );

      if (!visibility) {
        gitshiftOutputChannel?.appendLine('[publishToGitHub] User cancelled visibility selection');
        return;
      }

      // Get repository description (optional) - ask after visibility is selected
      const description = await vscode.window.showInputBox({
        prompt: 'Description (optional)',
        placeHolder: 'A short description of your repository',
        ignoreFocusOut: true
      });

      // Get GitHub account token (accounts already loaded above)
      let token: string | undefined;
      let username: string | undefined;

      if (accounts.length === 0) {
        // Try to sign in
        const session = await signInToGitHub();
        if (!session) {
          vscode.window.showWarningMessage('Please sign in with GitHub or add a token first');
          return;
        }
        token = session.accessToken;
        const user = await getGitHubUser(token);
        username = user.login;
      } else {
        // Try to get current account's token
        const currentUser = await getCurrentGitUser();
        let account: GitHubAccount | undefined;

        if (currentUser) {
          account = accounts.find(acc => acc.name === currentUser.name && acc.email === currentUser.email);
        }

        if (!account || !account.username) {
          // Show account picker
          const accountPicks = await Promise.all(accounts.map(async (acc) => {
            const label = acc.label;
            const detail = acc.email;

            if (acc.username && acc.authenticated) {
              try {
                const storedToken = await getGitHubToken(acc.username);
                if (storedToken) {
                  return { label, detail, account: acc, token: storedToken };
                }
              } catch (e) {
                // Ignore
              }
            }

            // Try VS Code session
            const sessions = await getGitHubSessions();
            if (sessions.length > 0) {
              return { label: `${label} (VS Code Session)`, detail, account: acc, token: sessions[0].accessToken };
            }

            return null;
          }));

          const validPicks = accountPicks.filter(p => p !== null) as Array<{ label: string; detail: string; account: GitHubAccount; token: string }>;

          if (validPicks.length === 0) {
            vscode.window.showWarningMessage('No authenticated GitHub account found. Please sign in or add a token.');
            return;
          }

          const selected = await vscode.window.showQuickPick(validPicks, {
            placeHolder: 'Select GitHub account to publish with'
          });

          if (!selected) return;

          token = selected.token;
          username = selected.account.username || (await getGitHubUser(token)).login;
        } else {
          // Use current account's token
          if (account.username && account.authenticated) {
            const storedToken = await getGitHubToken(account.username);
            if (storedToken) {
              token = storedToken;
              username = account.username;
            }
          }

          // Fallback to VS Code session
          if (!token) {
            const sessions = await getGitHubSessions();
            if (sessions.length > 0) {
              token = sessions[0].accessToken;
              const user = await getGitHubUser(token);
              username = user.login;

              // Update githubUsername if it changed
              if (username && username !== githubUsername) {
                githubUsername = username;
                gitshiftOutputChannel?.appendLine(`[publishToGitHub] Updated GitHub username to: ${githubUsername}`);
              }
            }
          }

          if (!token) {
            vscode.window.showWarningMessage('No GitHub authentication found. Please sign in or add a token.');
            return;
          }
        }
      }

      if (!token || !username) {
        vscode.window.showErrorMessage('Failed to get GitHub authentication');
        return;
      }

      // Ensure username matches the token we're using
      if (username !== githubUsername) {
        githubUsername = username;
        gitshiftOutputChannel?.appendLine(`[publishToGitHub] Final GitHub username: ${githubUsername}`);
      }

      // Initialize repository if not already initialized (silently, no prompt)
      const isGitRepo = await isGitRepository();
      gitshiftOutputChannel?.appendLine(`[publishToGitHub] Is Git repository: ${isGitRepo}`);
      if (!isGitRepo) {
        gitshiftOutputChannel?.appendLine('[publishToGitHub] Initializing repository silently...');
        const { initRepository } = await import('./gitOperations');
        await initRepository();
        gitshiftOutputChannel?.appendLine('[publishToGitHub] Repository initialized');
      }

      // Create repository on GitHub
      gitshiftOutputChannel?.appendLine('[publishToGitHub] Creating repository on GitHub...');
      vscode.window.showInformationMessage('Creating repository on GitHub...');
      const repo = await createGitHubRepository(token, repoName, description || '', visibility.isPrivate);
      gitshiftOutputChannel?.appendLine(`[publishToGitHub] Repository created: ${repo.html_url}`);

      // Add remote
      const { addRemote } = await import('./gitOperations');
      try {
        await addRemote('origin', repo.clone_url);
      } catch (error: any) {
        // Remote might already exist
        if (error.message?.includes('already exists')) {
          const { removeRemote } = await import('./gitOperations');
          await removeRemote('origin');
          await addRemote('origin', repo.clone_url);
        } else {
          throw error;
        }
      }

      // Update remote URL with token for authentication
      const { updateRemoteUrlWithToken } = await import('./gitCredentials');
      await updateRemoteUrlWithToken('origin', token, username);

      // Stage all files
      const { stageAll } = await import('./gitOperations');
      await stageAll();

      // Check if there are any files to commit
      const { getGitStatus } = await import('./gitOperations');
      const status = await getGitStatus();

      if (status.unstaged.length > 0 || status.untracked.length > 0) {
        // Stage remaining files
        await stageAll();
      }

      if (status.staged.length > 0 || status.unstaged.length > 0 || status.untracked.length > 0) {
        // Make initial commit
        const { commit } = await import('./gitOperations');
        await commit('Initial commit');
      }

      // Push to GitHub
      const { push } = await import('./gitOperations');
      await push();

      vscode.window.showInformationMessage(`Repository published to GitHub: ${repo.html_url}`);

      // Refresh views
      if (repositoryProvider) await repositoryProvider.refresh();
      // Add small delay to ensure Git repository is detected after all operations
      setTimeout(async () => {
        if (sidebarProvider) await sidebarProvider.refresh(true);
      }, 300);

      // Ask if user wants to open the repository
      const openRepo = await vscode.window.showInformationMessage(
        'Repository published successfully!',
        'Open on GitHub'
      );
      if (openRepo === 'Open on GitHub') {
        await vscode.env.openExternal(vscode.Uri.parse(repo.html_url));
      }
    } catch (error: any) {
      gitshiftOutputChannel?.appendLine(`[publishToGitHub] ERROR: ${error.message || 'Unknown error'}`);
      gitshiftOutputChannel?.appendLine(`[publishToGitHub] ERROR Stack: ${error.stack || 'No stack trace'}`);
      gitshiftOutputChannel?.show(true);
      vscode.window.showErrorMessage(`Failed to publish to GitHub: ${error.message}`);
    }
  });

  // Register settings command
  const openSettingsCommand = vscode.commands.registerCommand('gitshift.openSettings', async () => {
    await vscode.commands.executeCommand('workbench.action.openSettings', '@gitshift');
  });

  // Register account shortcut commands (Ctrl+Shift+1-5)
  const switchToAccount1Command = vscode.commands.registerCommand('gitshift.switchToAccount1', async () => {
    await switchToAccountByIndex(0);
  });

  const switchToAccount2Command = vscode.commands.registerCommand('gitshift.switchToAccount2', async () => {
    await switchToAccountByIndex(1);
  });

  const switchToAccount3Command = vscode.commands.registerCommand('gitshift.switchToAccount3', async () => {
    await switchToAccountByIndex(2);
  });

  const switchToAccount4Command = vscode.commands.registerCommand('gitshift.switchToAccount4', async () => {
    await switchToAccountByIndex(3);
  });

  const switchToAccount5Command = vscode.commands.registerCommand('gitshift.switchToAccount5', async () => {
    await switchToAccountByIndex(4);
  });

  context.subscriptions.push(
    switchAccountCommand,
    showActiveAccountCommand,
    switchToAccountCommand,
    refreshSidebarCommand,
    refreshTreeViewCommand,
    openConfigCommand,
    signInWithGitHubCommand,
    linkAccountCommand,
    deleteAccountTokenCommand,
    importAccountsCommand,
    quickCloneCommand,
    addTokenCommand,
    removeTokenCommand,
    pullCommand,
    pushCommand,
    syncCommand,
    fetchCommand,
    refreshChangesCommand,
    moreActionsCommand,
    cloneCommand,
    checkoutCommand,
    stashCommand,
    stashPopCommand,
    viewStashesCommand,
    createBranchCommand,
    deleteBranchCommand,
    mergeBranchCommand,
    rebaseBranchCommand,
    pullRebaseCommand,
    pushForceCommand,
    discardAllChangesCommand,
    amendCommitCommand,
    undoLastCommitCommand,
    openGitHubProfileCommand,
    refreshContributionsCommand,
    addRemoteCommand,
    removeRemoteCommand,
    viewRemotesCommand,
    showGitOutputCommand,
    initRepoCommand,
    publishToGitHubCommand,
    openSettingsCommand,
    switchToAccount1Command,
    switchToAccount2Command,
    switchToAccount3Command,
    switchToAccount4Command,
    switchToAccount5Command
  );

  // Listen for workspace folder changes
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(async () => {
      repositoryProvider.startFileWatcher();
      try {
        const isGitRepo = await isGitRepository();
        if (isGitRepo) {
          await updateStatusBar();
          // First try to auto-switch to associated account
          await autoSwitchToAssociatedAccount();
          // If no association, auto-activate account with repository access
          const associatedEmail = await getAssociatedAccount();
          if (!associatedEmail) {
            await autoActivateFirstAccount();
          }
        } else {
          // Not a git repository - auto-activate first account if needed
          await autoActivateFirstAccountIfNeeded();
        }
      } catch (error) {
        console.error('[GitShift] Workspace folder change handler failed:', error);
      }
    })
  );

  // Listen for authentication session changes to auto-store tokens
  context.subscriptions.push(
    vscode.authentication.onDidChangeSessions(async (e) => {
      if (e.provider.id === 'github') {
        try {
          // Get the current GitHub session
          const session = await vscode.authentication.getSession('github', ['repo', 'user:email', 'read:user'], {
            createIfNone: false,
            silent: true
          });

          if (session) {
            // Fetch user information to get the username
            const user = await getGitHubUser(session.accessToken);

            // Store or update the token (also registers in global registry)
            await storeGitHubToken(user.login, session.accessToken);

            // Check if this account exists in our accounts list
            const accounts = await loadAccounts();
            const existingAccount = accounts.find(a => a.username === user.login);

            if (existingAccount && !existingAccount.accountId) {
              // Update the account with the session info
              existingAccount.accountId = session.account.id;
              existingAccount.sessionId = session.id;
              existingAccount.authenticated = true;
              await saveAccounts(accounts);

              // Refresh UI
              if (treeProvider) {
                treeProvider.refresh();
              }
              if (sidebarProvider) {
                sidebarProvider.refresh();
              }
            }
          }
        } catch (error) {
          // Silent failure - this is just for convenience
        }
      }
    })
  );

  // Optional: Check GitHub authentication and warn about mismatches (non-blocking)
  checkGitHubAuthMismatch().catch(() => {
    // Silent failure - will check again on next repository operation
  });

  // Auto-import existing GitHub sessions on first launch
  autoImportGitHubAccounts().then(() => {
    // After auto-import, validate all account authentication states
    validateAccountAuthenticationStates().catch((error) => {
      console.error('[GitShift] Failed to validate account states:', error);
    });

    // Auto-activate first account if none is active
    // Check if we're in a repo to decide which function to use
    isGitRepository().then(isGitRepo => {
      if (isGitRepo) {
        autoActivateFirstAccount().catch((error) => {
          console.error('[GitShift] Auto-activation after import failed:', error);
        });
      } else {
        autoActivateFirstAccountIfNeeded().catch((error) => {
          console.error('[GitShift] Auto-activation after import failed:', error);
        });
      }
    }).catch(() => {
      // If check fails, try the no-repo version
      autoActivateFirstAccountIfNeeded().catch((error) => {
        console.error('[GitShift] Auto-activation after import failed:', error);
      });
    });
  }).catch((error) => {
    console.error('[GitShift] Auto-import failed:', error);
  });

  // Also check periodically if accounts exist but no user is active
  // This handles cases where accounts were loaded but git config wasn't set
  // Also handles when workspace is already open on IDE load
  setTimeout(async () => {
    try {
      const isGitRepo = await isGitRepository();
      if (isGitRepo) {
        await autoActivateFirstAccount();
      } else {
        await autoActivateFirstAccountIfNeeded();
      }
    } catch (error) {
      console.error('[GitShift] Auto-activation after 2 second delay failed:', error);
    }
  }, 2000); // Wait 2 seconds after initial load

  // Check immediately if workspace is already open when extension activates
  if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
    setTimeout(async () => {
      try {
        const isGitRepo = await isGitRepository();
        if (isGitRepo) {
          await autoActivateFirstAccount();
        } else {
          // Not a git repository - auto-activate first account if needed
          await autoActivateFirstAccountIfNeeded();
        }
      } catch (error) {
        console.error('[GitShift] Auto-activation for existing workspace failed:', error);
      }
    }, 3000); // Wait 3 seconds to ensure everything is initialized
  }
}

/**
 * Auto-activates the first account if no Git repository (regardless of current user)
 */
async function autoActivateFirstAccountIfNeeded(): Promise<void> {
  try {
    gitshiftOutputChannel?.appendLine('[autoActivateIfNeeded] Starting...');
    const isGitRepo = await isGitRepository();
    if (isGitRepo) {
      gitshiftOutputChannel?.appendLine('[autoActivateIfNeeded] In a git repository, skipping (use autoActivateFirstAccount instead)');
      // Don't auto-activate if already in a repo - use the other function instead
      return;
    }

    gitshiftOutputChannel?.appendLine('[autoActivateIfNeeded] Not in a git repository, checking for accounts...');
    const accounts = await loadAccounts();
    if (accounts.length === 0) {
      gitshiftOutputChannel?.appendLine('[autoActivateIfNeeded] No accounts available, skipping');
      // No accounts to activate
      return;
    }

    gitshiftOutputChannel?.appendLine(`[autoActivateIfNeeded] No repo. Auto-activating first account: ${accounts[0].label || accounts[0].name}`);
    await handleSwitchToAccount(accounts[0]);
    gitshiftOutputChannel?.appendLine('[autoActivateIfNeeded] Successfully activated first account');
  } catch (error: any) {
    gitshiftOutputChannel?.appendLine(`[autoActivateIfNeeded] Error: ${error.message || 'Unknown error'}`);
    gitshiftOutputChannel?.appendLine(`[autoActivateIfNeeded] Error stack: ${error.stack || 'No stack trace'}`);
    // Silent failure - don't interrupt user workflow
  }
}

/**
 * Switch to account by index (for keyboard shortcuts)
 */
async function switchToAccountByIndex(index: number): Promise<void> {
  try {
    const accounts = await loadAccounts();
    if (index >= accounts.length) {
      vscode.window.showWarningMessage(`No account configured at position ${index + 1}`);
      return;
    }
    await handleSwitchToAccount(accounts[index]);
    vscode.window.showInformationMessage(`Switched to account ${index + 1}: ${accounts[index].name}`);
  } catch (error: any) {
    vscode.window.showErrorMessage(`Failed to switch account: ${error.message}`);
  }
}

/**
 * Get the associated account for the current repository
 */
async function getAssociatedAccount(): Promise<string | undefined> {
  const config = vscode.workspace.getConfiguration('gitshift');
  const autoSwitch = config.get<boolean>('autoSwitchAccounts', true);

  if (!autoSwitch) {
    return undefined;
  }

  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) {
    return undefined;
  }

  const repoPath = workspaceFolder.uri.fsPath;
  const associations = config.get<{ [key: string]: string }>('repositoryAssociations', {});

  return associations[repoPath];
}

/**
 * Auto-switch to associated account if configured
 */
async function autoSwitchToAssociatedAccount(): Promise<void> {
  try {
    const associatedEmail = await getAssociatedAccount();
    if (!associatedEmail) {
      return;
    }

    const accounts = await loadAccounts();
    const account = accounts.find(acc => acc.email === associatedEmail);

    if (account) {
      gitshiftOutputChannel?.appendLine(`[autoSwitch] Switching to associated account: ${account.name}`);
      await handleSwitchToAccount(account);
    }
  } catch (error: any) {
    gitshiftOutputChannel?.appendLine(`[autoSwitch] Error: ${error.message}`);
  }
}

/**
 * Handles switching to a specific account (from tree view or webview)
 */
async function handleSwitchToAccount(account: GitHubAccount): Promise<void> {
  // Show loading state
  if (sidebarProvider) {
    sidebarProvider.postMessage({ type: 'setAccountLoading', email: account.email, loading: true });
  }

  try {
    // If account has username, first check if it's authenticated before switching
    if (account.username) {
      try {
        // Retrieve the stored access token for this account
        let accessToken = await extensionContext.secrets.get(`github-token-${account.username}`);

        // If token not found, try to get it from current VS Code GitHub session
        if (!accessToken && account.accountId) {
          try {
            const session = await getGitHubSessionByAccountId(account.accountId);
            if (session) {
              // Store the token for future use (also registers in global registry)
              await storeGitHubToken(account.username, session.accessToken);
              accessToken = session.accessToken;
            }
          } catch (error) {
            // Silent failure - will prompt user to re-authenticate if needed
          }
        }

        // Try to get current GitHub session as fallback
        // Prefer token vault only (do not prompt VS Code auth here)
        if (accessToken) {
          // Check if we're in a Git repository for repository-specific checks
          const isGitRepo = await isGitRepository();
          let hasRepoAccess = true;

          // Only check repository access if we're in a Git repository
          if (isGitRepo) {
            // Check if the user has access to this repository BEFORE switching
            const remoteUrl = await getRemoteUrl('origin');

            if (remoteUrl && remoteUrl.includes('github.com')) {
              const repoInfo = parseGitHubUrl(remoteUrl);
              if (repoInfo) {
                // Check if user is a collaborator with push access
                hasRepoAccess = await checkCollaboratorAccess(accessToken, repoInfo.owner, repoInfo.repo, account.username);

                if (!hasRepoAccess) {
                  const action = await vscode.window.showWarningMessage(
                    `${account.username} does not have collaborator access to repository ${repoInfo.owner}/${repoInfo.repo}. You may not be able to push commits.`,
                    { modal: true },
                    'Continue Anyway',
                    'Switch Account'
                  );

                  if (action === 'Switch Account') {
                    if (sidebarProvider) {
                      sidebarProvider.postMessage({ type: 'setAccountLoading', email: account.email, loading: false });
                    }
                    await handleSwitchAccount();
                    return; // Don't continue with switching
                  }
                  if (!action) {
                    // Clear loading state on cancel
                    if (sidebarProvider) {
                      sidebarProvider.postMessage({ type: 'setAccountLoading', email: account.email, loading: false });
                    }
                    return; // User canceled, don't switch
                  }
                  // User chose "Continue Anyway" - proceed with warning
                  vscode.window.showInformationMessage(
                    `Switched to ${account.username} (${account.name}) with no collaborator access to repository ${repoInfo.owner}/${repoInfo.repo}. You may not be able to push commits.`
                  );
                }
              }
            }
          }

          // Switch git config now that we have authentication and user confirmed
          await setGitUser(account.name, account.email);

          // Update the authenticated flag to true if it was false
          if (!account.authenticated) {
            const accounts = await loadAccounts();
            const idx = accounts.findIndex(a => a.username === account.username);
            if (idx >= 0) {
              accounts[idx].authenticated = true;
              await saveAccounts(accounts);
            }
          }

          // Configure git credential helper (works even without repository - sets global config)
          await configureGitCredentials(account.username, accessToken);

          // Update remote URL with token (only if in a Git repository)
          if (isGitRepo) {
            const remoteUrl = await getRemoteUrl('origin');
            if (remoteUrl && remoteUrl.includes('github.com')) {
              const repoInfo = parseGitHubUrl(remoteUrl);
              if (repoInfo) {
                await updateRemoteUrlWithToken('origin', accessToken, account.username);
              }
            }
          }

          if (!isGitRepo || hasRepoAccess) {
            vscode.window.showInformationMessage(
              `Switched to ${account.username} (${account.name})`
            );
          }
        } else {
          // Update the authenticated flag to false if there's no token
          if (account.authenticated) {
            const accounts = await loadAccounts();
            const idx = accounts.findIndex(a => a.username === account.username);
            if (idx >= 0) {
              accounts[idx].authenticated = false;
              await saveAccounts(accounts);
              // Refresh UI to update the badge
              if (treeProvider) treeProvider.refresh();
              if (sidebarProvider) sidebarProvider.refresh();
            }
          }

          const action = await vscode.window.showWarningMessage(
            `No token found for ${account.username}. Authentication is required to switch to this account.`,
            { modal: true },
            'Get Token'
          );

          if (action === 'Get Token') {
            // Show tutorial webview first
            await showTokenTutorial(account);
            // After tutorial, show the add token dialog
            await vscode.commands.executeCommand('gitshift.addToken', account);
          }

          // Don't continue with the switch - return early
          // Clear loading state
          if (sidebarProvider) {
            sidebarProvider.postMessage({ type: 'setAccountLoading', email: account.email, loading: false });
          }
          return;
        }
      } catch (error: any) {
        // Try to set git user even if credential configuration fails
        try {
          await setGitUser(account.name, account.email);
          const isGitRepo = await isGitRepository();
          if (isGitRepo) {
            vscode.window.showWarningMessage(
              `Switched to ${account.name}, but failed to configure git credentials. Please sign in again.`
            );
          } else {
            vscode.window.showInformationMessage(
              `Switched to ${account.name}. Initialize a Git repository to configure credentials.`
            );
          }
        } catch (setUserError: any) {
          // If setting git user also fails, check if it's because we're not in a repo
          const isGitRepo = await isGitRepository();
          if (isGitRepo) {
            vscode.window.showWarningMessage(
              `Failed to switch to ${account.name}. ${setUserError.message || 'Please check your git configuration.'}`
            );
          } else {
            // Without a repo, git config might fail, but we can still switch locally
            vscode.window.showInformationMessage(
              `Switched to ${account.name}. Initialize a Git repository to complete the setup.`
            );
          }
        }
        // Clear loading state on error
        if (sidebarProvider) {
          sidebarProvider.postMessage({ type: 'setAccountLoading', email: account.email, loading: false });
        }
      }
    } else {
      // Switch git config for accounts without GitHub authentication
      await setGitUser(account.name, account.email);
      vscode.window.showInformationMessage(
        `Switched to ${account.name} (local config only - no GitHub authentication)`
      );
    }

    // Update status bar
    await updateStatusBar();

    // Refresh tree view
    if (treeProvider) {
      treeProvider.refresh();
    }

    // Smoothly update sidebar webview without full refresh
    if (sidebarProvider) {
      const currentUser = await getCurrentGitUser();
      const accounts = await loadAccounts();
      const currentAccount = currentUser ? accounts.find(acc =>
        acc.name === currentUser.name && acc.email === currentUser.email
      ) || null : null;

      // Clear loading state before updating
      sidebarProvider.postMessage({ type: 'setAccountLoading', email: account.email, loading: false });

      // Send smooth update message
      await sidebarProvider.updateAccountState(currentUser, currentAccount);
      // Refresh contributions view when account changes
      if (contributionsProvider) {
        contributionsProvider.refresh();
      }
    }

    // Check for auth mismatch after switching
    await checkGitHubAuthMismatch();
  } catch (error: any) {
    vscode.window.showErrorMessage(
      `Failed to switch account. Please try again or check your git configuration.`
    );
    // Clear loading state on error
    if (sidebarProvider) {
      sidebarProvider.postMessage({ type: 'setAccountLoading', email: account.email, loading: false });
    }
  }
}

/**
 * Handles the switch account command
 */
async function handleSwitchAccount(): Promise<void> {
  try {
    // Check if accounts file exists
    const fileExists = await accountsFileExists();
    if (!fileExists) {
      const action = await vscode.window.showInformationMessage(
        'No GitHub accounts configured. Would you like to create a sample configuration file?',
        'Create Sample File',
        'Cancel'
      );

      if (action === 'Create Sample File') {
        await createDefaultAccountsFile();
        vscode.window.showInformationMessage(
          'Sample accounts file created at .vscode/github-accounts.json. Please edit it with your actual accounts.'
        );

        // Open the file for editing
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (workspaceFolders) {
          const accountsFile = vscode.Uri.joinPath(
            workspaceFolders[0].uri,
            '.vscode',
            'github-accounts.json'
          );
          await vscode.window.showTextDocument(accountsFile);
        }
      }
      return;
    }

    // Load accounts
    const accounts = await loadAccounts();
    if (accounts.length === 0) {
      vscode.window.showWarningMessage(
        'No accounts found in .vscode/github-accounts.json. Please add at least one account.'
      );
      return;
    }

    // Get current git user for highlighting
    const currentUser = await getCurrentGitUser();

    // Create quick pick items
    const quickPickItems = accounts.map((account) => {
      const isCurrent =
        currentUser &&
        currentUser.name === account.name &&
        currentUser.email === account.email;

      return {
        label: isCurrent ? `$(check) ${account.label}` : account.label,
        description: `${account.name} <${account.email}>`,
        detail: isCurrent ? 'Currently active' : undefined,
        account: account
      };
    });

    // Add option to add new account
    quickPickItems.push({
      label: '$(add) Add New Account',
      description: 'Open configuration file',
      detail: undefined,
      account: null as any
    });

    // Show quick pick
    const selected = await vscode.window.showQuickPick(quickPickItems, {
      placeHolder: 'Select a GitHub account',
      matchOnDescription: true
    });

    if (!selected) {
      return;
    }

    // Handle add new account
    if (!selected.account) {
      const workspaceFolders = vscode.workspace.workspaceFolders;
      if (workspaceFolders) {
        const accountsFile = vscode.Uri.joinPath(
          workspaceFolders[0].uri,
          '.vscode',
          'github-accounts.json'
        );
        await vscode.window.showTextDocument(accountsFile);
      }
      return;
    }

    // Use the new handler
    await handleSwitchToAccount(selected.account);
  } catch (error: any) {
    vscode.window.showErrorMessage(
      `Failed to switch account: ${error.message}`
    );
  }
}

/**
 * Handles the show active account command
 */
async function handleShowActiveAccount(): Promise<void> {
  try {
    const isGitRepo = await isGitRepository();
    if (!isGitRepo) {
      vscode.window.showErrorMessage(
        'Not in a Git repository. Please open a Git repository.'
      );
      return;
    }

    const gitUser = await getCurrentGitUser();
    if (gitUser) {
      const remoteUrl = await getGitRemoteUrl();
      let message = `Current Git Identity:\n\nName: ${gitUser.name}\nEmail: ${gitUser.email}`;

      if (remoteUrl) {
        message += `\n\nRemote: ${remoteUrl}`;
      }

      vscode.window.showInformationMessage(message, { modal: false });
    } else {
      vscode.window.showWarningMessage(
        'No Git identity configured for this repository.'
      );
    }
  } catch (error: any) {
    vscode.window.showErrorMessage(
      `Failed to get active account: ${error.message}`
    );
  }
}

/**
 * Checks for mismatches between git config and GitHub authentication
 */
async function checkGitHubAuthMismatch(): Promise<void> {
  try {
    // Get GitHub session
    const session = await vscode.authentication.getSession('github', ['user:email', 'read:user'], {
      createIfNone: false
    });

    if (!session) {
      // No GitHub session, skip check
      return;
    }

    // Get current git user
    const gitUser = await getCurrentGitUser();
    if (!gitUser) {
      return;
    }

    // Get GitHub account info (email from session)
    // Note: The session object contains account info
    const githubEmail = session.account.label; // This might be the email or username

    // Simple check - this is a basic implementation
    // In a real scenario, you might need to fetch user email via GitHub API
    if (gitUser.email !== githubEmail && !githubEmail.includes(gitUser.email)) {
      const action = await vscode.window.showWarningMessage(
        `Git email (${gitUser.email}) may not match your GitHub session. This could cause attribution issues.`,
        'Switch Account',
        'Dismiss'
      );

      if (action === 'Switch Account') {
        await handleSwitchAccount();
      }
    }
  } catch (error) {
    // Silent fail - this is optional functionality
  }
}

/**
 * Handles opening the config file
 */
async function handleOpenConfig(): Promise<void> {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length === 0) {
    vscode.window.showErrorMessage('No workspace folder is open');
    return;
  }

  const configExists = await accountsFileExists();

  if (!configExists) {
    const action = await vscode.window.showInformationMessage(
      'Configuration file does not exist. Would you like to create it?',
      'Create',
      'Cancel'
    );

    if (action === 'Create') {
      await createDefaultAccountsFile();
    } else {
      return;
    }
  }

  const accountsFile = vscode.Uri.joinPath(
    workspaceFolders[0].uri,
    '.vscode',
    'github-accounts.json'
  );

  await vscode.window.showTextDocument(accountsFile);
}

/**
 * Handles signing in with GitHub
 */
async function handleSignInWithGitHub(): Promise<void> {
  try {
    // Load existing accounts to determine if we should force a new session
    const accounts = await loadAccounts();
    const forceNew = accounts.length > 0; // Force new session if accounts exist

    const session = await signInToGitHub(forceNew);

    if (!session) {
      // User cancelled, that's okay
      return;
    }

    // Check if the session has all required scopes, especially notifications
    const hasNotificationsScope = session.scopes && session.scopes.includes('notifications');
    let workingSession = session;

    if (!hasNotificationsScope) {
      // Force a new session to get the required scopes
      const newSession = await signInToGitHub(true);
      if (!newSession || !newSession.scopes || !newSession.scopes.includes('notifications')) {
        vscode.window.showWarningMessage('This account needs to grant notification permissions. Please sign in again.');
        return;
      }
      workingSession = newSession;
    }

    // Fetch user information for whichever account they signed in with
    const user = await getGitHubUser(workingSession.accessToken);
    const emails = await getGitHubEmails(workingSession.accessToken);

    // Get primary email or first verified email, fallback to user.email from API
    const primaryEmail = emails.find(e => e.primary && e.verified)?.email ||
      emails.find(e => e.verified)?.email ||
      emails.find(e => e.primary)?.email ||
      emails[0]?.email ||
      user.email;

    if (!primaryEmail) {
      throw new Error('Unable to retrieve email address. Please ensure your token has the "user:email" scope enabled.');
    }

    // Create account from GitHub data - accept whatever account they chose
    const newAccount: GitHubAccount = {
      label: `${user.login}`,
      name: user.name || user.login,
      email: primaryEmail,
      sessionId: workingSession.id,
      accountId: workingSession.account.id,  // Store account ID for session retrieval
      username: user.login,
      avatarUrl: user.avatar_url,  // Store GitHub avatar URL
      authenticated: true
    };

    // Store the access token securely for this account (also registers in global registry)
    await storeGitHubToken(user.login, workingSession.accessToken);

    // Check if this exact account already exists
    const existingIndex = accounts.findIndex(a =>
      a.username === user.login ||
      (a.email === newAccount.email && a.sessionId === workingSession.id)
    );

    if (existingIndex >= 0) {
      // Update existing account with latest session info
      accounts[existingIndex] = {
        ...accounts[existingIndex],
        ...newAccount
      };
      await saveAccounts(accounts);

      vscode.window.showInformationMessage(
        `Account ${user.login} updated!`
      );
    } else {
      // Add new account - whichever one the user chose
      accounts.push(newAccount);
      await saveAccounts(accounts);

      vscode.window.showInformationMessage(
        `Account ${user.login} added! You can now switch to it anytime.`
      );
    }

    // Refresh UI
    if (treeProvider) {
      treeProvider.refresh();
    }
    if (sidebarProvider) {
      sidebarProvider.refresh();
    }

    // Auto-activate this account if none is currently active
    const isGitRepo = await isGitRepository();
    if (isGitRepo) {
      await autoActivateFirstAccount().catch(() => {
        // Silent failure
      });
    } else {
      await autoActivateFirstAccountIfNeeded().catch(() => {
        // Silent failure
      });
    }

  } catch (error: any) {
    // Only show error if it's not a user cancellation
    if (error.message && !error.message.includes('User did not consent')) {
      vscode.window.showErrorMessage(`Failed to sign in with GitHub. Please try again.`);
    }
  }
}

/**
 * Handles linking an existing account to GitHub
 */
async function handleLinkAccount(account: GitHubAccount): Promise<void> {
  try {
    const session = await signInToGitHub();

    if (!session) {
      return;
    }

    // Fetch user information
    const user = await getGitHubUser(session.accessToken);

    // Store the access token securely (also registers in global registry)
    await storeGitHubToken(user.login, session.accessToken);

    // Load accounts and update the specified one
    const accounts = await loadAccounts();
    const index = accounts.findIndex(a =>
      a.email === account.email && a.name === account.name
    );

    if (index >= 0) {
      accounts[index] = {
        ...accounts[index],
        sessionId: session.id,
        accountId: session.account.id,
        username: user.login,
        avatarUrl: user.avatar_url,
        authenticated: true
      };

      await saveAccounts(accounts);

      vscode.window.showInformationMessage(
        `Account linked to GitHub user ${user.login}`
      );

      // Refresh UI
      if (treeProvider) {
        treeProvider.refresh();
      }
      if (sidebarProvider) {
        sidebarProvider.refresh();
      }
    }

  } catch (error: any) {
    vscode.window.showErrorMessage(`Failed to link account. Please try again.`);
  }
}

/**
 * Validates that all accounts' authenticated flags match their actual token status
 * Also validates tokens against GitHub API to check if they're still valid
 */
async function validateAccountAuthenticationStates(): Promise<void> {
  try {
    log('[GitShift] Validating account authentication states...');
    const accounts = await loadAccounts();
    let needsUpdate = false;
    const invalidTokens: string[] = [];

    for (const account of accounts) {
      if (!account.username) continue;

      // Check if token exists in storage
      const token = await extensionContext.secrets.get(`github-token-${account.username}`);
      const hasToken = !!token;

      if (!hasToken) {
        // No token exists - update authenticated flag to false
        if (account.authenticated !== false) {
          account.authenticated = false;
          needsUpdate = true;
          log(`[GitShift] Token validation: No token found for ${account.username}, marking as unauthenticated`);
        }
        continue;
      }

      // Token exists - validate it against GitHub API
      try {
        await validateGitHubToken(token);
        // Token is valid
        if (account.authenticated !== true) {
          account.authenticated = true;
          needsUpdate = true;
          log(`[GitShift] Token validation: Token for ${account.username} is valid`);
        }
      } catch (error: any) {
        // Token is invalid (expired, revoked, or deleted)
        log(`[GitShift] Token validation: Token for ${account.username} is invalid: ${error.message}`);
        invalidTokens.push(account.username);

        // Mark as unauthenticated
        if (account.authenticated !== false) {
          account.authenticated = false;
          needsUpdate = true;
        }

        // Optionally remove invalid token from storage
        try {
          await deleteGitHubToken(account.username);
          log(`[GitShift] Token validation: Removed invalid token for ${account.username}`);
        } catch (deleteError) {
          logError(`[GitShift] Token validation: Failed to remove invalid token for ${account.username}`, deleteError);
        }
      }
    }

    // Save if any changes were made
    if (needsUpdate) {
      await saveAccounts(accounts);
      log(`[GitShift] Token validation: Updated ${invalidTokens.length} invalid token(s), refreshed ${needsUpdate ? accounts.length : 0} account(s)`);

      // Refresh UI
      if (treeProvider) treeProvider.refresh();
      if (sidebarProvider) sidebarProvider.refresh();

      // Show notification if tokens were invalidated
      if (invalidTokens.length > 0) {
        vscode.window.showWarningMessage(
          `GitHub token(s) for ${invalidTokens.length} account${invalidTokens.length > 1 ? 's' : ''} (${invalidTokens.join(', ')}) ${invalidTokens.length > 1 ? 'are' : 'is'} no longer valid. Please add a new token.`,
          { modal: false }
        );
      }
    } else {
      log('[GitShift] Token validation: All tokens are valid');
    }
  } catch (error) {
    logError('Failed to validate account authentication states', error);
  }
}

/**
 * Helper function to log to both console and output channel
 */
function log(message: string): void {

  if (gitshiftOutputChannel) {
    gitshiftOutputChannel.appendLine(message);
  }
}

function logError(message: string, error?: any): void {
  const fullMessage = error ? `${message}: ${error}` : message;
  console.error(fullMessage);
  if (gitshiftOutputChannel) {
    gitshiftOutputChannel.appendLine(`ERROR: ${fullMessage}`);
  }
}

/**
 * Automatically activates the first available account if no account is currently active
 */
async function autoActivateFirstAccount(): Promise<void> {
  try {
    log('[GitShift] Auto-activation: Starting...');
    // Check if we're in a git repository
    const isGitRepo = await isGitRepository();
    if (!isGitRepo) {
      log('[GitShift] Auto-activation: Not in a git repository, skipping');
      return; // Not in a git repo, don't auto-activate
    }
    log('[GitShift] Auto-activation: In a git repository');

    // Check if there's already an active git user
    const currentUser = await getCurrentGitUser();
    if (currentUser) {
      log(`[GitShift] Auto-activation: Current git user found: ${currentUser.name} <${currentUser.email}>`);
      // Already has an active user, check if it matches an account
      const accounts = await loadAccounts();
      const matchingAccount = accounts.find(acc =>
        acc.name === currentUser.name && acc.email === currentUser.email
      );

      if (matchingAccount) {
        // User is already set and matches an account, nothing to do
        log('[GitShift] Auto-activation: Current user matches account, no activation needed');
        return;
      }
      log('[GitShift] Auto-activation: Current user does not match any account, will activate');
    } else {
      log('[GitShift] Auto-activation: No current git user, will activate');
    }

    // No active user or doesn't match any account, try to find account with repo access
    const accounts = await loadAccounts();
    log(`[GitShift] Auto-activation: Found ${accounts.length} accounts`);
    if (accounts.length === 0) {
      log('[GitShift] Auto-activation: No accounts available, skipping');
      return; // No accounts available
    }

    // Try to get the repository info from remote URL
    let accountToActivate: GitHubAccount | null = null;
    try {
      const remoteUrl = await getGitRemoteUrl();
      log(`[GitShift] Auto-activation: Remote URL: ${remoteUrl || 'none'}`);
      if (!remoteUrl) {
        log('[GitShift] Auto-activation: No remote URL found, will use first account');
      } else {
        const repoInfo = parseGitHubUrl(remoteUrl);
        log(`[GitShift] Auto-activation: Parsed repo info: ${repoInfo ? `${repoInfo.owner}/${repoInfo.repo}` : 'null'}`);

        if (!repoInfo) {
          log('[GitShift] Auto-activation: Not a GitHub repository or could not parse URL, will use first account');
        } else if (repoInfo) {
          // It's a GitHub repository, check which account has access
          // Get all accounts that have tokens (from workspace accounts or global registry)
          const accountsWithTokens: Array<{ account: GitHubAccount; username: string }> = [];

          // First, check workspace accounts with usernames
          log(`[GitShift] Auto-activation: Processing ${accounts.length} workspace accounts...`);
          for (const account of accounts) {
            if (account.username) {
              accountsWithTokens.push({ account, username: account.username });
              log(`[GitShift] Auto-activation: Added workspace account ${account.label || account.name} (${account.username})`);
            } else {
              log(`[GitShift] Auto-activation: Skipping account ${account.label || account.name} - no username`);
            }
          }

          // Also check global token registry for accounts not in workspace
          try {
            const storedTokens = await getAllStoredTokens();
            log(`[GitShift] Auto-activation: Found ${storedTokens.length} tokens in global registry`);
            for (const stored of storedTokens) {
              // Only add if not already in our list
              if (!accountsWithTokens.find(item => item.username === stored.username)) {
                // Try to find matching account by username, or create a placeholder
                const existingAccount = accounts.find(acc => acc.username === stored.username);
                if (existingAccount) {
                  accountsWithTokens.push({ account: existingAccount, username: stored.username });
                  log(`[GitShift] Auto-activation: Added global registry account ${existingAccount.label || existingAccount.name} (${stored.username})`);
                } else {
                  log(`[GitShift] Auto-activation: Token exists for ${stored.username} but account not in workspace, skipping`);
                  // Account with token exists but not in workspace accounts - we'll skip for now
                  // as we need full account info to activate
                }
              } else {
                log(`[GitShift] Auto-activation: Account ${stored.username} already in list, skipping`);
              }
            }
          } catch (error) {
            logError('[GitShift] Auto-activation: Error getting stored tokens', error);
            // Continue if we can't get stored tokens
          }

          log(`[GitShift] Auto-activation: Total accounts with tokens: ${accountsWithTokens.length}`);

          // Prefer authenticated accounts
          const authenticatedAccounts = accountsWithTokens.filter(item => item.account.authenticated);
          const otherAccounts = accountsWithTokens.filter(item => !item.account.authenticated);

          log(`[GitShift] Auto-activation: Checking ${authenticatedAccounts.length} authenticated accounts and ${otherAccounts.length} other accounts for repo access`);
          log(`[GitShift] Auto-activation: Checking access to ${repoInfo.owner}/${repoInfo.repo}`);
          log(`[GitShift] Auto-activation: Authenticated account usernames: ${authenticatedAccounts.map(a => a.username).join(', ')}`);

          // First, check if repository owner account has access (prioritize owner)
          const ownerAccount = authenticatedAccounts.find(item => item.username === repoInfo.owner);
          if (ownerAccount) {
            log(`[GitShift] Auto-activation: Found repository owner account in authenticated list`);
            try {
              log(`[GitShift] Auto-activation: Checking repository owner account ${ownerAccount.account.label || ownerAccount.account.name} (${ownerAccount.username}) first...`);
              const token = await getGitHubToken(ownerAccount.username);
              if (token) {
                log(`[GitShift] Auto-activation: Token found for repository owner ${ownerAccount.username}, checking repo access...`);
                const hasAccess = await checkRepoAccess(token, repoInfo.owner, repoInfo.repo);
                log(`[GitShift] Auto-activation: Repository owner ${ownerAccount.username} has access: ${hasAccess}`);
                if (hasAccess) {
                  accountToActivate = ownerAccount.account;
                  log(`[GitShift] Auto-activation: Activating repository owner account: ${ownerAccount.account.label || ownerAccount.account.name} (${ownerAccount.username})`);
                } else {
                  log(`[GitShift] Auto-activation: Repository owner ${ownerAccount.username} does not have access, will check other accounts`);
                }
              } else {
                log(`[GitShift] Auto-activation: No token found for repository owner ${ownerAccount.username}`);
              }
            } catch (error) {
              logError(`[GitShift] Auto-activation: Error checking repository owner account ${ownerAccount.username}`, error);
            }
          } else {
            log(`[GitShift] Auto-activation: Repository owner ${repoInfo.owner} not found in authenticated accounts, will check all accounts for access`);
          }

          // If owner account doesn't have access or wasn't found, check other authenticated accounts
          if (!accountToActivate) {
            // Check authenticated accounts (excluding owner if we already checked it)
            for (const { account, username } of authenticatedAccounts) {
              if (ownerAccount && username === ownerAccount.username) {
                continue; // Skip owner, we already checked it
              }
              try {
                log(`[GitShift] Auto-activation: Checking account ${account.label || account.name} (${username})...`);
                const token = await getGitHubToken(username);
                if (token) {
                  log(`[GitShift] Auto-activation: Token found for ${username}, checking repo access...`);
                  const hasAccess = await checkRepoAccess(token, repoInfo.owner, repoInfo.repo);
                  log(`[GitShift] Auto-activation: ${username} has access: ${hasAccess}`);
                  if (hasAccess) {
                    accountToActivate = account;
                    log(`[GitShift] Auto-activation: Found account with repo access: ${account.label || account.name} (${username})`);
                    break;
                  }
                } else {
                  log(`[GitShift] Auto-activation: No token found for ${username}`);
                }
              } catch (error) {
                logError(`[GitShift] Auto-activation: Error checking account ${username}`, error);
                // Continue checking other accounts
                continue;
              }
            } // End for loop
          } // End if (!accountToActivate)

          // If no authenticated account has access, check other accounts with tokens
          if (!accountToActivate) {
            log(`[GitShift] Auto-activation: No authenticated account has access, checking other accounts...`);
            for (const { account, username } of otherAccounts) {
              try {
                log(`[GitShift] Auto-activation: Checking account ${account.label || account.name} (${username})...`);
                const token = await getGitHubToken(username);
                if (token) {
                  log(`[GitShift] Auto-activation: Token found for ${username}, checking repo access...`);
                  const hasAccess = await checkRepoAccess(token, repoInfo.owner, repoInfo.repo);
                  log(`[GitShift] Auto-activation: ${username} has access: ${hasAccess}`);
                  if (hasAccess) {
                    accountToActivate = account;
                    log(`[GitShift] Auto-activation: Found account with repo access: ${account.label || account.name} (${username})`);
                    break;
                  }
                } else {
                  log(`[GitShift] Auto-activation: No token found for ${username}`);
                }
              } catch (error) {
                logError(`[GitShift] Auto-activation: Error checking account ${username}`, error);
                // Continue checking other accounts
                continue;
              }
            }
          }

          if (!accountToActivate) {
            log(`[GitShift] Auto-activation: No account found with access to ${repoInfo.owner}/${repoInfo.repo}, will fall back to first account`);
          }
        }
      }
    } catch (error) {
      // If we can't get remote URL or check access, fall through to default behavior
      logError('[GitShift] Auto-activation: Could not check repository access, falling back to first account', error);
    }

    // If no account with repo access found, use default: first authenticated account
    if (!accountToActivate) {
      accountToActivate = accounts.find(acc => acc.authenticated) || accounts[0];
      log(`[GitShift] Auto-activation: No account with repo access found, using first account: ${accountToActivate.label || accountToActivate.name}`);
    }

    // Switch to the selected account
    if (accountToActivate) {
      log(`[GitShift] Auto-activation: Activating account: ${accountToActivate.label || accountToActivate.name} (${accountToActivate.email})`);
      try {
        await handleSwitchToAccount(accountToActivate);
        log(`[GitShift] Auto-activation: Successfully activated account: ${accountToActivate.label || accountToActivate.name}`);
      } catch (switchError: any) {
        logError('[GitShift] Auto-activation: Failed to switch to account', switchError);
        throw switchError; // Re-throw to be caught by outer catch
      }
    } else {
      log('[GitShift] Auto-activation: No account to activate');
    }
  } catch (error) {
    logError('[GitShift] Auto-activation failed', error);
    // Don't silently fail - log it so we can debug
  }
}

/**
 * Auto-imports existing GitHub sessions from VS Code and all stored PAT tokens
 */
async function autoImportGitHubAccounts(): Promise<void> {
  try {
    // Show loading state in sidebar
    if (sidebarProvider) {
      sidebarProvider.postMessage({ type: 'setImporting', importing: true });
    }

    // Check if we've already run auto-import for this workspace
    const workspaceId = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || 'no-workspace';
    const hasAutoImported = extensionContext.workspaceState.get(`hasAutoImported-${workspaceId}`, false);

    // Load existing accounts
    const accounts = await loadAccounts();
    let importedCount = 0;
    let updatedCount = 0;

    // Step 1: Import current VS Code session
    const sessions = await getGitHubSessions();

    for (const session of sessions) {
      try {
        // Fetch user information
        const user = await getGitHubUser(session.accessToken);
        const emails = await getGitHubEmails(session.accessToken);
        // Get primary email or first verified email, fallback to user.email from API
        const primaryEmail = emails.find(e => e.primary && e.verified)?.email ||
          emails.find(e => e.verified)?.email ||
          emails.find(e => e.primary)?.email ||
          emails[0]?.email ||
          user.email;

        if (!primaryEmail) {
          throw new Error('Unable to retrieve email address. Please ensure your token has the "user:email" scope enabled.');
        }

        // Check if this account already exists
        const existingIndex = accounts.findIndex(acc =>
          acc.username === user.login || acc.email === primaryEmail
        );

        if (existingIndex >= 0) {
          // Always update email with fresh data from GitHub API when auto-importing
          accounts[existingIndex] = {
            ...accounts[existingIndex],
            label: `${user.login}`,
            name: user.name || user.login,
            email: primaryEmail,
            sessionId: session.id,
            accountId: session.account.id,
            username: user.login,
            avatarUrl: user.avatar_url,
            authenticated: true
          };
          updatedCount++;
        } else {
          // Create new account
          const newAccount: GitHubAccount = {
            label: `${user.login}`,
            name: user.name || user.login,
            email: primaryEmail,
            sessionId: session.id,
            accountId: session.account.id,
            username: user.login,
            avatarUrl: user.avatar_url,
            authenticated: true
          };

          // Add to accounts
          accounts.push(newAccount);
          importedCount++;
        }

        // Store token (this also registers it in the global registry)
        await storeGitHubToken(user.login, session.accessToken);

      } catch (error) {
        console.error('Failed to import VS Code session:', error);
        // Continue with other sessions
      }
    }

    // Step 2: Import all accounts with stored PAT tokens from any workspace
    const storedTokens = await getAllStoredTokens();

    for (const { username, token } of storedTokens) {
      try {
        // Check if this account is already imported in this workspace
        const existingIndex = accounts.findIndex(acc => acc.username === username);

        if (existingIndex >= 0) {
          // Account already exists in this workspace, just ensure authenticated flag is set
          if (!accounts[existingIndex].authenticated) {
            accounts[existingIndex].authenticated = true;
            updatedCount++;
          }
          continue; // Skip to next token
        }

        // Validate token and fetch user info
        const { user } = await validateGitHubToken(token);
        const emails = await getGitHubEmails(token);
        // Get primary email or first verified email, fallback to user.email from API
        const primaryEmail = emails.find(e => e.primary && e.verified)?.email ||
          emails.find(e => e.verified)?.email ||
          emails.find(e => e.primary)?.email ||
          emails[0]?.email ||
          user.email;

        if (!primaryEmail) {
          console.warn(`Failed to retrieve email for ${username}, skipping account import`);
          continue; // Skip this account if we can't get email
        }

        // Create new account from stored token
        const newAccount: GitHubAccount = {
          label: `${user.login}`,
          name: user.name || user.login,
          email: primaryEmail,
          sessionId: '',
          accountId: '',
          username: user.login,
          avatarUrl: user.avatar_url,
          authenticated: true
        };

        // Add to accounts
        accounts.push(newAccount);
        importedCount++;

      } catch (error) {
        console.error(`Failed to import stored token for ${username}:`, error);
        // Token might be invalid or expired - continue with others
      }
    }

    if (importedCount > 0 || updatedCount > 0) {
      // Save updated accounts
      await saveAccounts(accounts);

      // Show notification only if new accounts were imported and this is first time
      if (importedCount > 0 && !hasAutoImported) {
        const message = storedTokens.length > 0
          ? `Imported ${importedCount} GitHub account${importedCount > 1 ? 's' : ''} (including accounts from other workspaces)!`
          : `Imported ${importedCount} GitHub account${importedCount > 1 ? 's' : ''} from VS Code!`;
        vscode.window.showInformationMessage(message);
      }

      // Refresh UI
      if (treeProvider) {
        treeProvider.refresh();
      }
      if (sidebarProvider) {
        sidebarProvider.refresh();
      }
    } else if (!hasAutoImported) {
      // No accounts to import on first launch
    }

    // Mark as imported for this workspace
    await extensionContext.workspaceState.update(`hasAutoImported-${workspaceId}`, true);

    // Hide loading state
    if (sidebarProvider) {
      sidebarProvider.postMessage({ type: 'setImporting', importing: false });
    }

  } catch (error) {
    console.error('Auto-import failed:', error);
    // Hide loading state on error
    if (sidebarProvider) {
      sidebarProvider.postMessage({ type: 'setImporting', importing: false });
    }
    // Silent failure - users can manually import accounts
  }
}

/**
 * Helper function to handle git operations with proper error handling
 */
async function handleGitOperation(operationName: string, operation: () => Promise<void>): Promise<void> {
  try {
    const isGitRepo = await isGitRepository();
    if (!isGitRepo) {
      vscode.window.showErrorMessage('Not in a Git repository');
      return;
    }
    await operation();
  } catch (error: any) {
    vscode.window.showErrorMessage(`Failed to ${operationName}: ${error.message}`);
  }
}

/**
 * Shows a tutorial webview panel for creating a GitHub Personal Access Token
 */
async function showTokenTutorial(_account?: GitHubAccount): Promise<void> {
  // Create and show a webview panel with token tutorial
  const panel = vscode.window.createWebviewPanel(
    'tokenTutorial',
    'GitHub Token Tutorial',
    vscode.ViewColumn.Beside,
    {
      enableScripts: true,
      retainContextWhenHidden: false
    }
  );

  const tutorialHtml = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>GitHub Token Tutorial</title>
    <style>
        @import url('https://cdn.jsdelivr.net/npm/@vscode/codicons@0.0.35/dist/codicon.css');
        .codicon {
            font-family: var(--vscode-icon-font-family);
        }
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
            background: var(--vscode-editor-background);
            color: var(--vscode-foreground);
            padding: 24px;
            line-height: 1.6;
        }
        .header {
            margin-bottom: 24px;
        }
        .header h1 {
            font-size: 24px;
            margin-bottom: 8px;
            color: var(--vscode-foreground);
        }
        .header p {
            color: var(--vscode-descriptionForeground);
            font-size: 14px;
        }
        .step {
            background: var(--vscode-sideBar-background);
            border: 1px solid var(--vscode-panel-border);
            border-radius: 6px;
            padding: 16px;
            margin-bottom: 16px;
        }
        .step-number {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            width: 28px;
            height: 28px;
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border-radius: 50%;
            font-weight: 600;
            font-size: 14px;
            margin-right: 12px;
            vertical-align: middle;
        }
        .step-title {
            font-size: 16px;
            font-weight: 600;
            margin-bottom: 8px;
            color: var(--vscode-foreground);
            display: inline-block;
        }
        .step-content {
            margin-left: 40px;
            margin-top: 8px;
        }
        .step-content ol {
            margin-left: 20px;
            margin-top: 8px;
        }
        .step-content li {
            margin-bottom: 8px;
            color: var(--vscode-descriptionForeground);
        }
        .step-content strong {
            color: var(--vscode-foreground);
        }
        .important-note {
            background: var(--vscode-inputValidation-warningBackground);
            border: 1px solid var(--vscode-inputValidation-warningBorder);
            border-radius: 6px;
            padding: 16px;
            margin: 20px 0;
        }
        .important-note-title {
            font-weight: 600;
            margin-bottom: 8px;
            color: var(--vscode-notificationsWarningIcon-foreground);
            display: flex;
            align-items: center;
            gap: 8px;
        }
        .scope-list {
            background: var(--vscode-editor-background);
            border: 1px solid var(--vscode-panel-border);
            border-radius: 4px;
            padding: 12px;
            margin-top: 12px;
        }
        .scope-item {
            padding: 6px 0;
            border-bottom: 1px solid var(--vscode-panel-border);
        }
        .scope-item:last-child {
            border-bottom: none;
        }
        .scope-name {
            font-weight: 600;
            color: var(--vscode-foreground);
        }
        .scope-desc {
            font-size: 13px;
            color: var(--vscode-descriptionForeground);
            margin-top: 4px;
        }
        .button-group {
            display: flex;
            gap: 12px;
            margin-top: 24px;
            justify-content: flex-end;
        }
        .btn {
            padding: 10px 20px;
            border: none;
            border-radius: 4px;
            font-size: 14px;
            font-weight: 500;
            cursor: pointer;
            transition: all 0.2s;
        }
        .btn-primary {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
        }
        .btn-primary:hover {
            background: var(--vscode-button-hoverBackground);
        }
        .btn-secondary {
            background: transparent;
            color: var(--vscode-button-secondaryForeground);
            border: 1px solid var(--vscode-button-border);
        }
        .btn-secondary:hover {
            background: var(--vscode-button-secondaryHoverBackground);
        }
        .link {
            color: var(--vscode-textLink-foreground);
            text-decoration: underline;
            cursor: pointer;
        }
        code {
            background: var(--vscode-textCodeBlock-background);
            padding: 2px 6px;
            border-radius: 3px;
            font-family: 'Courier New', monospace;
            font-size: 13px;
        }
    </style>
</head>
<body>
    <div class="header">
        <h1><i class="codicon codicon-key"></i> GitHub Personal Access Token</h1>
        <p>Follow these steps to create and add your GitHub Personal Access Token</p>
    </div>

    <div class="step">
        <span class="step-number">1</span>
        <span class="step-title">Go to GitHub Token Settings</span>
        <div class="step-content">
            <p>Open the GitHub Personal Access Tokens page:</p>
            <p>
                <button class="btn btn-primary" onclick="vscode.postMessage({command: 'openTokenPage'})" style="margin-top: 8px;">
                    <i class="codicon codicon-link-external" style="margin-right: 4px; font-size: 14px; vertical-align: text-bottom;"></i>Open GitHub Token Page
                </button>
            </p>
            <p style="margin-top: 8px; font-size: 12px; color: var(--vscode-descriptionForeground);">
                Or manually: GitHub Settings → Developer settings → Personal access tokens → Tokens (classic) → Generate new token (classic)
            </p>
        </div>
    </div>

    <div class="step">
        <span class="step-number">2</span>
        <span class="step-title">Generate New Token</span>
        <div class="step-content">
            <ol>
                <li>Click <strong>"Generate new token"</strong> → <strong>"Generate new token (classic)"</strong></li>
                <li>Give your token a descriptive name (e.g., "GitShift for VS Code")</li>
                <li>Set an expiration date (or "No expiration" for long-term use)</li>
            </ol>
        </div>
    </div>

    <div class="step">
        <span class="step-number">3</span>
        <span class="step-title">Select Required Scopes</span>
        <div class="step-content">
            <p>Enable the following scopes (checkboxes):</p>
            <div class="scope-list">
                <div class="scope-item">
                    <div class="scope-name"><i class="codicon codicon-package" style="margin-right:4px; vertical-align:middle;"></i>repo</div>
                    <div class="scope-desc">Full control of private repositories (required for Git operations)</div>
                </div>
                <div class="scope-item">
                    <div class="scope-name"><i class="codicon codicon-mail" style="margin-right:4px; vertical-align:middle;"></i>user:email</div>
                    <div class="scope-desc">Access user email addresses (required to get your actual email, not no-reply GitHub email)</div>
                </div>
                <div class="scope-item">
                    <div class="scope-name"><i class="codicon codicon-account" style="margin-right:4px; vertical-align:middle;"></i>read:user</div>
                    <div class="scope-desc">Read user profile data (required to see all contributions, including public repos)</div>
                </div>
            </div>
            <p style="margin-top: 12px;"><strong>Important:</strong> 
            <ul style="margin-top: 8px; margin-left: 20px;">
                <li>Without <code>read:user</code> scope, you'll only see contributions from private repositories.</li>
                <li>Without <code>user:email</code> scope, we may use your no-reply GitHub email instead of your actual email.</li>
            </ul>
            </p>
            <p style="margin-top: 12px; padding: 8px; background: var(--vscode-textBlockQuote-background); border-left: 3px solid var(--vscode-textLink-foreground);">
                <strong><i class="codicon codicon-lightbulb" style="margin-right:4px;"></i>Tip:</strong> If you prefer, you can use <strong>"Sign In with GitHub"</strong> instead, which automatically includes all required scopes (repo, user:email, read:user)!
            </p>
        </div>
    </div>

    <div class="step">
        <span class="step-number">4</span>
        <span class="step-title">Generate and Copy Token</span>
        <div class="step-content">
            <ol>
                <li>Scroll down and click <strong>"Generate token"</strong></li>
                <li><strong>IMPORTANT:</strong> Copy the token immediately - you won't be able to see it again!</li>
                <li>The token will look like: <code>ghp_EXAMPLE_TOKEN_HERE</code></li>
            </ol>
        </div>
    </div>

    <div class="important-note">
        <div class="important-note-title">
            <i class="codicon codicon-warning" style="margin-right:4px;"></i>Security Reminder
        </div>
        <p>Never share your token publicly or commit it to version control. Treat it like a password!</p>
    </div>

    <div class="button-group">
        <button class="btn btn-secondary" onclick="vscode.postMessage({command: 'cancel'})">Cancel</button>
        <button class="btn btn-primary" onclick="vscode.postMessage({command: 'proceed'})">I've Created My Token - Continue</button>
    </div>

    <script>
        const vscode = acquireVsCodeApi();
    </script>
</body>
</html>`;

  panel.webview.html = tutorialHtml;

  // Handle messages from the tutorial panel
  return new Promise<void>((resolve) => {
    const disposables: vscode.Disposable[] = [];

    disposables.push(
      panel.webview.onDidReceiveMessage(async (message) => {
        if (message.command === 'openTokenPage') {
          // Open GitHub token creation page with pre-filled parameters
          const tokenUrl = 'https://github.com/settings/tokens/new?scopes=repo,user:email,read:user&description=GitShift+for+VS+Code';
          await vscode.env.openExternal(vscode.Uri.parse(tokenUrl));
        } else if (message.command === 'proceed') {
          // Close tutorial and proceed to token input
          panel.dispose();
          disposables.forEach(d => d.dispose());
          resolve();
        } else if (message.command === 'cancel') {
          panel.dispose();
          disposables.forEach(d => d.dispose());
          resolve();
        }
      })
    );

    disposables.push(
      panel.onDidDispose(() => {
        disposables.forEach(d => d.dispose());
        resolve();
      })
    );
  });
}

/**
 * Deactivates the extension
 */
export function deactivate() {

}

