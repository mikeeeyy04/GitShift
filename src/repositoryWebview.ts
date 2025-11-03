/**
 * GitShift - Repository Webview Provider
 * Copyright (c) 2025 mikeeeyy04
 * https://github.com/mikeeeyy04/GitShift
 * 
 * MIT License - See LICENSE file for details
 */

import * as vscode from 'vscode';
import {
  getGitStatus,
  stageFiles,
  stageAll,
  unstageFiles,
  commit,
  push,
  pull,
  fetch,
  discardChanges,
  getBranches,
  getCurrentBranch,
  createBranch,
  checkoutBranch,
  deleteBranch,
  getCommitHistory,
  GitStatus,
  Branch,
  CommitInfo
} from './gitOperations';
import { isGitRepository } from './gitManager';
import { CommitDetailsPanel } from './commitDetailsWebview';
import { generateDetailedCommitMessage, generateFallbackMessage, LanguageModelGenerationError } from './commitMessageGenerator';

export class RepositoryProvider implements vscode.WebviewViewProvider {
  private _view?: vscode.WebviewView;
  private _fileWatcher?: vscode.FileSystemWatcher;
  private _refreshTimeout?: NodeJS.Timeout;
  private _isVisible: boolean = false;
  private _cachedStatus: GitStatus | null = null;
  private _lastRefresh: number = 0;
  private _activeTab: string = 'changes';
  private _commitsLimit: number = 20;
  private _generationCancelToken?: vscode.CancellationTokenSource;

  constructor(private readonly _extensionUri: vscode.Uri) { }

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ) {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri]
    };

    // Track visibility state
    this._isVisible = webviewView.visible;
    webviewView.onDidChangeVisibility(() => {
      this._isVisible = webviewView.visible;
      // Refresh when becoming visible if data is stale
      if (this._isVisible && Date.now() - this._lastRefresh > 2000) {
        this._loadContent();
      }
    });

    webviewView.webview.html = this._getLoadingHtml();

    // Only load content if visible (respects openOnStartup setting)
    if (this._isVisible) {
      this._loadContent();
    }

    // File watcher is set up separately to work even when webview is not visible

    webviewView.webview.onDidReceiveMessage(async (data) => {
      try {
        switch (data.type) {
          case 'switchTab':
            // Just update the state, don't reload - tab switching is handled client-side
            this._activeTab = data.tab;
            break;
          case 'refresh':
            await this.refresh();
            if (this._view) {
              this._view.webview.postMessage({ type: 'clearLoading', buttonId: 'refreshBtn' });
            }
            break;
          case 'stageAll':
            await this._handleStageAll();
            break;
          case 'stageFile':
            await this._handleStageFile(data.file);
            break;
          case 'unstageFile':
            await this._handleUnstageFile(data.file);
            break;
          case 'commit':
            await this._handleCommit(data.message);
            break;
          case 'commitAndPush':
            await this._handleCommitAndPush(data.message);
            break;
          case 'push':
            await this._handlePush();
            break;
          case 'pull':
            await this._handlePull();
            break;
          case 'fetch':
            await this._handleFetch();
            break;
          case 'discard':
            await this._handleDiscard(data.file);
            break;
          case 'openDiff':
            await this._handleOpenDiff(data.file);
            break;
          case 'createBranch':
            await this._handleCreateBranch(data.name);
            break;
          case 'switchBranch':
            await this._handleSwitchBranch(data.name);
            break;
          case 'deleteBranch':
            await this._handleDeleteBranch(data.name);
            break;
          case 'loadMore':
            await this._handleLoadMore();
            break;
          case 'openCommitDiff':
            await this._handleOpenCommitDiff(data.hash);
            break;
          case 'generateCommitMessage':
            await this._handleGenerateCommitMessage();
            break;
          case 'stopGeneration':
            await this._handleStopGeneration();
            break;
        }
      } catch (error: any) {
        // Show modal dialog for push errors
        const isPushError = data.type === 'push' || data.type === 'commitAndPush';
        if (isPushError) {
          vscode.window.showErrorMessage(`GitShift: ${error.message}`, { modal: true });
        } else {
          vscode.window.showErrorMessage(`GitShift: ${error.message}`);
        }
        // Clear any loading states on error
        if (this._view) {
          this._view.webview.postMessage({ type: 'clearAllLoading' });
        }
      }
    });
  }

  public async refresh() {
    // Clear cache on manual refresh
    this._cachedStatus = null;
    await this._loadContent();
  }

  private async _loadContent() {
    if (!this._view) {
      return;
    }

    // Only load if visible or first time
    if (!this._isVisible && this._lastRefresh > 0) {
      return;
    }

    this._lastRefresh = Date.now();
    const html = await this._getHtmlContent();
    this._view.webview.html = html;
  }

  /**
   * Start file watcher to detect changes even when webview is not visible
   */
  public startFileWatcher() {
    // Dispose existing watcher if it exists
    if (this._fileWatcher) {
      this._fileWatcher.dispose();
      this._fileWatcher = undefined;
    }

    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
      return;
    }

    this._fileWatcher = vscode.workspace.createFileSystemWatcher('**/*');

    const debouncedRefresh = () => {
      if (this._refreshTimeout) {
        clearTimeout(this._refreshTimeout);
      }
      this._refreshTimeout = setTimeout(() => {
        this._cachedStatus = null;
        if (this._isVisible) {
          this.refresh();
        }
      }, 1000);
    };

    this._fileWatcher.onDidChange(debouncedRefresh);
    this._fileWatcher.onDidCreate(debouncedRefresh);
    this._fileWatcher.onDidDelete(debouncedRefresh);
  }

  public dispose() {
    if (this._fileWatcher) {
      this._fileWatcher.dispose();
    }
    if (this._refreshTimeout) {
      clearTimeout(this._refreshTimeout);
    }
  }

  // Changes handlers
  private async _handleStageAll() {
    await stageAll();
    vscode.window.showInformationMessage('All changes staged');
    await this.refresh();
  }

  private async _handleStageFile(file: string) {
    await stageFiles([file]);
    await this.refresh();
  }

  private async _handleUnstageFile(file: string) {
    await unstageFiles([file]);
    await this.refresh();
  }

  private async _handleCommit(message: string) {
    if (!message || !message.trim()) {
      vscode.window.showWarningMessage('Commit message cannot be empty');
      if (this._view) {
        this._view.webview.postMessage({ type: 'clearLoading', buttonId: 'commitBtn' });
      }
      return;
    }
    await commit(message);
    vscode.window.showInformationMessage('Changes committed');
    await this.refresh();
    if (this._view) {
      this._view.webview.postMessage({ type: 'clearLoading', buttonId: 'commitBtn' });
    }
  }

  private async _handleCommitAndPush(message: string) {
    if (!message || !message.trim()) {
      vscode.window.showWarningMessage('Commit message cannot be empty');
      if (this._view) {
        this._view.webview.postMessage({ type: 'clearLoading', buttonId: 'commitPushBtn' });
      }
      return;
    }
    await commit(message);
    vscode.window.showInformationMessage('Changes committed');
    await push();
    vscode.window.showInformationMessage('Pushed to remote');
    await this.refresh();
    if (this._view) {
      this._view.webview.postMessage({ type: 'clearLoading', buttonId: 'commitPushBtn' });
    }
  }

  private async _handleGenerateCommitMessage() {
    if (!this._view) return;

    // Create cancellation token for this generation
    this._generationCancelToken = new vscode.CancellationTokenSource();

    try {
      // Get current git status
      const status = await getGitStatus();

      // Generate commit message using LM (pass cancellation token)
      const message = await generateDetailedCommitMessage(status, this._generationCancelToken.token);

      // Send the message to the webview to populate the textarea
      this._view.webview.postMessage({
        type: 'commitMessageGenerated',
        message
      });

      // Clear loading state
      this._view.webview.postMessage({ type: 'clearLoading', buttonId: 'generateMsgBtn' });
    } catch (error: any) {
      // Check if this is a LanguageModelGenerationError and should prompt user
      if (error instanceof LanguageModelGenerationError || error.name === 'LanguageModelGenerationError') {
        // Get status for fallback generation
        const status = await getGitStatus();

        // Show dialog asking if user wants a simple message (only show once per session)
        const result = await vscode.window.showWarningMessage(
          'AI commit message generation is not available. Would you like a simple message based on file names?',
          'Yes'
        );

        if (result === 'Yes') {
          const fallbackMessage = generateFallbackMessage(status);

          // Send the fallback message to the webview
          if (this._view) {
            this._view.webview.postMessage({
              type: 'commitMessageGenerated',
              message: fallbackMessage
            });
          }
        }

        // Clear loading state
        if (this._view) {
          this._view.webview.postMessage({ type: 'clearLoading', buttonId: 'generateMsgBtn' });
        }
      } else {
        // Other errors - also show fallback option
        const status = await getGitStatus();
        const result = await vscode.window.showErrorMessage(
          `Failed to generate AI commit message: ${error.message || 'Unknown error'}. Would you like a simple message?`,
          'Yes',
          'Cancel'
        );

        if (result === 'Yes') {
          const fallbackMessage = generateFallbackMessage(status);
          if (this._view) {
            this._view.webview.postMessage({
              type: 'commitMessageGenerated',
              message: fallbackMessage
            });
          }
        }

        if (this._view) {
          this._view.webview.postMessage({ type: 'clearLoading', buttonId: 'generateMsgBtn' });
        }
      }
    } finally {
      // Always dispose of the cancellation token
      if (this._generationCancelToken) {
        this._generationCancelToken.dispose();
        this._generationCancelToken = undefined;
      }
    }
  }

  private async _handleStopGeneration() {
    if (this._generationCancelToken) {
      this._generationCancelToken.cancel();
    }
    // Clear loading state (already handled by webview, but do it here too for safety)
    if (this._view) {
      this._view.webview.postMessage({ type: 'clearLoading', buttonId: 'generateMsgBtn' });
    }
  }

  private async _handlePush() {
    await push();
    vscode.window.showInformationMessage('Pushed to remote');
    await this.refresh();
    if (this._view) {
      this._view.webview.postMessage({ type: 'clearLoading', buttonId: 'pushBtn' });
    }
  }

  private async _handlePull() {
    await pull();
    vscode.window.showInformationMessage('Pulled from remote');
    await this.refresh();
    if (this._view) {
      this._view.webview.postMessage({ type: 'clearLoading', buttonId: 'pullBtn' });
    }
  }

  private async _handleFetch() {
    await fetch();
    vscode.window.showInformationMessage('Fetched from remote');
    await this.refresh();
    if (this._view) {
      this._view.webview.postMessage({ type: 'clearLoading', buttonId: 'fetchBtn' });
    }
  }

  private async _handleDiscard(file: string) {
    const confirm = await vscode.window.showWarningMessage(
      `Discard changes in '${file}'?`,
      { modal: true },
      'Discard'
    );
    if (confirm === 'Discard') {
      await discardChanges([file]);
      vscode.window.showInformationMessage('Changes discarded');
      await this.refresh();
    }
  }

  private async _handleOpenDiff(file: string) {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) {
      return;
    }

    const workspaceRoot = workspaceFolders[0].uri;
    const fileUri = vscode.Uri.joinPath(workspaceRoot, file);

    try {
      await vscode.workspace.fs.stat(fileUri);

      try {
        await vscode.commands.executeCommand('git.openChange', fileUri);
      } catch (gitError) {
        const gitUri = fileUri.with({
          scheme: 'git',
          path: fileUri.path,
          query: JSON.stringify({
            path: fileUri.fsPath,
            ref: 'HEAD'
          })
        });

        const title = `${file} (Working Tree ↔ HEAD)`;
        await vscode.commands.executeCommand('vscode.diff', gitUri, fileUri, title);
      }
    } catch (error) {
      try {
        await vscode.window.showTextDocument(fileUri);
      } catch (openError: any) {
        vscode.window.showErrorMessage(`Failed to open file: ${openError.message}`);
      }
    }
  }

  // Branches handlers
  private async _handleCreateBranch(branchName: string) {
    if (!branchName || !branchName.trim()) {
      vscode.window.showWarningMessage('Branch name cannot be empty');
      return;
    }
    await createBranch(branchName);
    vscode.window.showInformationMessage(`Branch '${branchName}' created`);
    await this.refresh();
  }

  private async _handleSwitchBranch(branchName: string) {
    await checkoutBranch(branchName);
    vscode.window.showInformationMessage(`Switched to branch '${branchName}'`);
    await this.refresh();
  }

  private async _handleDeleteBranch(branchName: string) {
    const confirm = await vscode.window.showWarningMessage(
      `Delete branch '${branchName}'?`,
      { modal: true },
      'Delete'
    );
    if (confirm === 'Delete') {
      await deleteBranch(branchName);
      vscode.window.showInformationMessage(`Branch '${branchName}' deleted`);
      await this.refresh();
    }
  }

  // Commits handlers
  private async _handleLoadMore() {
    this._commitsLimit = 50;
    await this._loadContent();
  }

  private async _handleOpenCommitDiff(hash: string) {
    try {
      CommitDetailsPanel.show(this._extensionUri, hash);
    } catch (error: any) {
      vscode.window.showErrorMessage(`Failed to open commit: ${error.message}`);
    }
  }

  private _getLoadingHtml(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body {
      font-family: var(--vscode-font-family);
      background: transparent;
      color: var(--vscode-foreground);
      padding: 20px;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100px;
    }
    .spinner {
      width: 20px;
      height: 20px;
      border: 2px solid var(--vscode-panel-border);
      border-top-color: var(--vscode-foreground);
      border-radius: 50%;
      animation: spin 0.6s linear infinite;
    }
    @keyframes spin {
      to { transform: rotate(360deg); }
    }
  </style>
</head>
<body>
  <div class="spinner"></div>
</body>
</html>`;
  }

  private async _getHtmlContent(): Promise<string> {
    let isGitRepo = false;
    let status: GitStatus | null = null;
    let branches: Branch[] = [];
    let currentBranch = '';
    let commits: CommitInfo[] = [];

    try {
      isGitRepo = await isGitRepository();
      if (isGitRepo) {
        // Get status (cached)
        if (this._cachedStatus && Date.now() - this._lastRefresh < 2000) {
          status = this._cachedStatus;
        } else {
          status = await getGitStatus();
          this._cachedStatus = status;
        }

        // Get branches
        branches = await getBranches();
        currentBranch = await getCurrentBranch();

        // Get commits
        commits = await getCommitHistory(this._commitsLimit);
      }
    } catch (error) {
      // Silent fail
    }

    const localBranches = branches.filter(b => !b.remote);
    const remoteBranches = branches.filter(b => b.remote);

    // Generate HTML content for each tab
    const changesTabContent = this._getChangesTabContent(isGitRepo, status);
    const branchesTabContent = this._getBranchesTabContent(isGitRepo, localBranches, remoteBranches, currentBranch);
    const commitsTabContent = this._getCommitsTabContent(isGitRepo, commits, currentBranch);

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link href="https://cdn.jsdelivr.net/npm/@vscode/codicons@0.0.35/dist/codicon.css" rel="stylesheet" />
  <title>Repository</title>
  <style>
    ${this._getAllStyles()}
  </style>
</head>
<body>
  ${!isGitRepo ? `
    <div class="warning-box">
      <i class="codicon codicon-warning"></i>
      <span>Not in a Git repository</span>
    </div>
  ` : `
    <!-- Tab Navigation -->
    <div class="tab-nav">
      <button class="tab-btn ${this._activeTab === 'changes' ? 'active' : ''}" data-tab="changes" onclick="switchTab('changes')">
        <i class="codicon codicon-diff"></i>
        <span>Changes</span>
      </button>
      <button class="tab-btn ${this._activeTab === 'branches' ? 'active' : ''}" data-tab="branches" onclick="switchTab('branches')">
        <i class="codicon codicon-git-branch"></i>
        <span>Branches</span>
      </button>
      <button class="tab-btn ${this._activeTab === 'commits' ? 'active' : ''}" data-tab="commits" onclick="switchTab('commits')">
        <i class="codicon codicon-git-commit"></i>
        <span>Commits</span>
      </button>
    </div>

    <!-- Tab Contents -->
    <div class="tab-content">
      <div class="tab-pane ${this._activeTab === 'changes' ? 'active' : ''}" id="changes-tab">
        ${changesTabContent}
      </div>
      <div class="tab-pane ${this._activeTab === 'branches' ? 'active' : ''}" id="branches-tab">
        ${branchesTabContent}
      </div>
      <div class="tab-pane ${this._activeTab === 'commits' ? 'active' : ''}" id="commits-tab">
        ${commitsTabContent}
      </div>
    </div>
  `}

  <script>
    ${this._getAllScripts()}
  </script>
</body>
</html>`;
  }

  private _getChangesTabContent(isGitRepo: boolean, status: GitStatus | null): string {
    if (!isGitRepo || !status) {
      return '';
    }

    return `
      <!-- Compact Header with Branch and Stats -->
      <div class="changes-header">
        <div class="branch-line">
          <div class="branch-name-badge">
            <i class="codicon codicon-git-branch"></i>
            <span>${status.branch}</span>
          </div>
          ${status.ahead > 0 || status.behind > 0 ? `
            <div class="sync-indicators">
              ${status.ahead > 0 ? `<span class="sync-ind ahead" title="${status.ahead} ahead">↑${status.ahead}</span>` : ''}
              ${status.behind > 0 ? `<span class="sync-ind behind" title="${status.behind} behind">↓${status.behind}</span>` : ''}
            </div>
          ` : ''}
        </div>
        <div class="stats-line">
          <div class="stat-item staged">
            <span class="stat-dot"></span>
            <span class="stat-text">${status.staged.length} staged</span>
          </div>
          <div class="stat-item modified">
            <span class="stat-dot"></span>
            <span class="stat-text">${status.unstaged.length + status.untracked.length} unstaged</span>
          </div>
        </div>
      </div>

      <!-- Action Buttons -->
      <div class="actions-row">
        <button id="pullBtn" class="action-btn" onclick="pullWithLoading()" title="Pull changes">
          <i class="codicon codicon-arrow-down"></i>
          <span>Pull</span>
        </button>
        <button id="pushBtn" class="action-btn primary" onclick="pushWithLoading()" title="Push changes">
          <i class="codicon codicon-arrow-up"></i>
          <span>Push</span>
        </button>
        <button id="fetchBtn" class="action-btn" onclick="fetchWithLoading()" title="Fetch from remote">
          <i class="codicon codicon-sync"></i>
          <span>Fetch</span>
        </button>
        <button id="refreshBtn" class="action-btn" onclick="refreshWithLoading()" title="Refresh status">
          <i class="codicon codicon-refresh"></i>
          <span>Refresh</span>
        </button>
      </div>

      <!-- Commit Section -->
      ${status.staged.length > 0 ? `
        <div class="commit-box">
          <div class="commit-box-header">
            <div class="commit-label">
              <i class="codicon codicon-comment"></i>
              <span>Commit ${status.staged.length} file${status.staged.length !== 1 ? 's' : ''}</span>
            </div>
            <button id="generateMsgBtn" class="icon-btn" onclick="fillCommitMessage()" title="Generate commit message">
              <i class="codicon codicon-sparkle"></i>
            </button>
          </div>
          <div style="position: relative;">
            <div id="commitMessageLoader" class="commit-message-loader" style="display: none;"></div>
            <textarea id="commitMessage" placeholder="Describe your changes..." onkeydown="handleCommitKeyboard(event)"></textarea>
          </div>
          <div class="commit-actions-row">
            <button id="commitBtn" class="commit-action-btn" onclick="commitOnlyWithLoading()">
              <i class="codicon codicon-check"></i>
              <span>Commit</span>
            </button>
            <button id="commitPushBtn" class="commit-action-btn primary" onclick="commitAndPushWithLoading()">
              <i class="codicon codicon-rocket"></i>
              <span>Commit & Push</span>
            </button>
          </div>
        </div>
      ` : ''}

      <!-- Empty State -->
      ${status.staged.length === 0 && status.unstaged.length === 0 && status.untracked.length === 0 ? `
        <div class="empty-state">
          <div class="empty-state-icon">
            <i class="codicon codicon-check-all"></i>
          </div>
          <h3>No Changes</h3>
          <p>Your working tree is clean</p>
        </div>
      ` : ''}

      <!-- All Changes Section -->
      ${status.staged.length > 0 || status.unstaged.length > 0 || status.untracked.length > 0 ? `
        <div class="section">
          <div class="section-header" id="all-changes-header" onclick="toggleSection('all-changes')">
            <div class="section-title">
              <i class="codicon codicon-chevron-down section-chevron"></i>
              <span class="section-label">All Changes</span>
              <span class="section-count">${status.staged.length + status.unstaged.length + status.untracked.length}</span>
            </div>
            <div class="section-actions" onclick="event.stopPropagation()">
              ${status.unstaged.length > 0 || status.untracked.length > 0 ? `
                <button class="quick-action" onclick="stageAll()" title="Stage all unstaged">
                  <i class="codicon codicon-add"></i> Stage All
                </button>
              ` : ''}
              ${status.staged.length > 0 ? `
                <button class="quick-action" onclick="unstageAll()" title="Unstage all">
                  <i class="codicon codicon-remove"></i> Unstage All
                </button>
              ` : ''}
            </div>
          </div>
          <div class="section-content" id="all-changes-content">
            ${[
          ...status.staged.map(file => ({ file, status: 'staged', isStaged: true })),
          ...status.unstaged.map(file => ({ file, status: 'modified', isStaged: false })),
          ...status.untracked.map(file => ({ file, status: 'untracked', isStaged: false }))
        ].map(({ file, status: fileStatus, isStaged }) => {
          const fileName = file.split('/').pop();
          const filePath = file.includes('/') ? file.substring(0, file.lastIndexOf('/')) : '';
          const iconClass = fileStatus === 'staged' ? 'codicon-diff-added' :
            fileStatus === 'modified' ? 'codicon-diff-modified' :
              'codicon-new-file';
          const statusClass = fileStatus;
          const isModified = fileStatus === 'modified';

          return `
              <div class="list-item ${statusClass}" data-file="${file.replace(/"/g, '&quot;')}" data-status="${fileStatus}">
                <i class="codicon ${iconClass} file-status-icon ${statusClass}"></i>
                <div class="file-info" onclick="openDiff('${file.replace(/'/g, "\\'")}')">
                  <div class="file-name">${fileName}</div>
                  ${filePath ? `<div class="file-path">${filePath}</div>` : ''}
                </div>
                <div class="file-actions">
                  ${isStaged ? `
                    <button class="file-action" onclick="unstageFile('${file.replace(/'/g, "\\'")}')" title="Unstage">−</button>
                  ` : `
                    <button class="file-action" onclick="stageFile('${file.replace(/'/g, "\\'")}')" title="Stage">+</button>
                    ${isModified ? `<button class="file-action danger" onclick="discardFile('${file.replace(/'/g, "\\'")}')" title="Discard changes">×</button>` : ''}
                  `}
                </div>
              </div>
            `;
        }).join('')}
          </div>
        </div>
      ` : ''}
    `;
  }

  private _getBranchesTabContent(isGitRepo: boolean, localBranches: Branch[], remoteBranches: Branch[], _currentBranch: string): string {
    if (!isGitRepo) {
      return '';
    }

    return `
      <div class="section">
        <div class="input-container">
          <input type="text" id="newBranchName" placeholder="Create new branch..." onkeypress="if(event.key==='Enter')createNewBranchWithLoading()" />
          <button id="addBtn" class="add-btn" onclick="createNewBranchWithLoading()">Add</button>
        </div>
      </div>

      <div class="section">
        <div class="section-header">LOCAL BRANCHES (${localBranches.length})</div>
        ${localBranches.length === 0 ? `
          <div class="empty-state">No local branches</div>
        ` : ''}
        ${localBranches.map(branch => `
          <div class="list-item ${branch.current ? 'active' : ''}" id="branch-${branch.name.replace(/[^a-zA-Z0-9]/g, '-')}" onclick="switchToBranchWithLoading('${branch.name}')">
            <i class="codicon codicon-git-branch branch-icon"></i>
            <span class="branch-name">${branch.name}</span>
            ${branch.current ? '<span class="badge">Current</span>' : ''}
            ${!branch.current ? `
              <div class="branch-actions">
                <button class="action-btn" onclick="event.stopPropagation(); removeBranchWithLoading('${branch.name}')">Delete</button>
              </div>
            ` : ''}
          </div>
        `).join('')}
      </div>

      ${remoteBranches.length > 0 ? `
        <div class="section">
          <div class="section-header">REMOTE BRANCHES (${remoteBranches.length})</div>
          ${remoteBranches.map(branch => `
            <div class="list-item">
              <i class="codicon codicon-cloud branch-icon"></i>
              <span class="branch-name">${branch.name}</span>
            </div>
          `).join('')}
        </div>
      ` : ''}
    `;
  }

  private _getCommitsTabContent(isGitRepo: boolean, commits: CommitInfo[], currentBranch: string): string {
    if (!isGitRepo) {
      return '';
    }

    return `
      <div class="header">
        <div class="branch-info">
          <i class="codicon codicon-git-branch"></i>
          <span class="branch-name">${currentBranch}</span>
        </div>
        <button id="refreshBtn" class="refresh-btn" onclick="refreshWithLoading()">Refresh</button>
      </div>

      ${commits.length === 0 ? `
        <div class="empty-state">
          <i class="codicon codicon-git-commit empty-state-icon"></i>
          <div>No commits yet</div>
        </div>
      ` : ''}

      ${commits.length > 0 ? `
        <div class="commit-list">
          ${commits.map(commit => {
      const refs = commit.refs || '';
      const refBadges = [];

      if (refs.includes('HEAD')) {
        refBadges.push('<span class="ref-badge head"><i class="codicon codicon-target"></i>HEAD</span>');
      }
      if (refs.includes('main') && !refs.includes('origin/main')) {
        refBadges.push('<span class="ref-badge main"><i class="codicon codicon-git-branch"></i>main</span>');
      }
      if (refs.includes('origin/main')) {
        refBadges.push('<span class="ref-badge origin"><i class="codicon codicon-cloud"></i>origin/main</span>');
      }
      if (refs.includes('origin/') && !refs.includes('origin/main')) {
        const originMatch = refs.match(/origin\/([^,\s]+)/);
        if (originMatch) {
          refBadges.push(`<span class="ref-badge origin"><i class="codicon codicon-cloud"></i>${originMatch[0]}</span>`);
        }
      }

      return `
              <div class="commit-item" onclick="openCommitDiff('${commit.hash}')">
                <div class="commit-header">
                  <span class="commit-hash">${commit.hash.substring(0, 7)}</span>
                  <span class="commit-date">${commit.date}</span>
                </div>
                <div class="commit-message">${commit.message}</div>
                <div class="commit-footer">
                  <div class="commit-author">${commit.author}</div>
                  ${refBadges.length > 0 ? `
                    <div class="commit-refs">
                      ${refBadges.join('')}
                    </div>
                  ` : ''}
                </div>
              </div>
            `;
    }).join('')}
        </div>

        ${commits.length >= 20 ? `
          <div class="load-more">
            <button id="loadMoreBtn" class="load-more-btn" onclick="loadMoreWithLoading()">Load More</button>
          </div>
        ` : ''}
      ` : ''}
    `;
  }

  private _getAllStyles(): string {
    return `
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }

    body {
      font-family: var(--vscode-font-family), -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      background: transparent;
      color: var(--vscode-foreground);
      padding: 12px;
      font-size: 13px;
      line-height: 1.6;
      overflow-x: hidden;
    }

    .codicon[class*='codicon-'] {
      font-size: 14px !important;
    }

    .file-status-icon.codicon {
      font-size: 16px !important;
    }

    /* Tab Navigation */
    .tab-nav {
      display: flex;
      gap: 0;
      margin-bottom: 16px;
      border-bottom: 1px solid var(--vscode-panel-border);
      position: sticky;
      top: 0;
      z-index: 100;
      background: var(--vscode-sideBar-background);
      margin-left: -12px;
      margin-right: -12px;
      margin-top: -12px;
      padding: 0 12px;
      overflow-x: auto;
      scrollbar-width: none;
      -ms-overflow-style: none;
    }

    .tab-nav::-webkit-scrollbar {
      display: none;
    }

    .tab-btn {
      flex: 1;
      min-width: fit-content;
      padding: 10px 12px;
      background: transparent;
      border: none;
      border-bottom: 2px solid transparent;
      color: var(--vscode-foreground);
      cursor: pointer;
      font-family: inherit;
      font-size: 12px;
      font-weight: 500;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      transition: all 0.2s ease;
      opacity: 0.7;
      white-space: nowrap;
    }

    .tab-btn:hover {
      opacity: 1;
      background: var(--vscode-list-hoverBackground);
    }

    .tab-btn.active {
      opacity: 1;
      border-bottom-color: var(--vscode-focusBorder);
      font-weight: 600;
    }

    .tab-btn i {
      font-size: 14px;
      flex-shrink: 0;
    }

    .tab-btn span {
      display: inline;
    }

    /* Responsive: Hide text labels on very narrow widths */
    @media (max-width: 250px) {
      .tab-btn {
        padding: 10px 8px;
        gap: 0;
      }
      
      .tab-btn span {
        display: none;
      }
      
      .tab-btn i {
        font-size: 16px;
      }
    }

    .tab-content {
      position: relative;
      min-height: 200px;
    }

    .tab-pane {
      display: none;
    }

    .tab-pane.active {
      display: block;
    }

    /* Include all styles from changes, branches, and commits */
    ${this._getChangesStyles()}
    ${this._getBranchesStyles()}
    ${this._getCommitsStyles()}
    ${this._getScrollbarStyles()}
    `;
  }

  private _getChangesStyles(): string {
    return `
    /* Compact Header */
    .changes-header {
      background: var(--vscode-editor-background);
      border: 1px solid var(--vscode-panel-border);
      border-radius: 4px;
      padding: 10px 12px;
      margin-bottom: 12px;
    }

    .branch-line {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 8px;
    }

    .branch-name-badge {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 12px;
      font-weight: 600;
      color: var(--vscode-foreground);
    }

    .branch-name-badge i {
      font-size: 14px;
      opacity: 0.8;
    }

    .sync-indicators {
      display: flex;
      gap: 6px;
    }

    .sync-ind {
      font-size: 10px;
      font-weight: 600;
      padding: 2px 6px;
      border-radius: 3px;
      font-family: var(--vscode-editor-font-family), monospace;
    }

    .sync-ind.ahead {
      color: var(--vscode-gitDecoration-addedResourceForeground);
      background: rgba(var(--vscode-gitDecoration-addedResourceForeground), 0.15);
    }

    .sync-ind.behind {
      color: var(--vscode-gitDecoration-modifiedResourceForeground);
      background: rgba(var(--vscode-gitDecoration-modifiedResourceForeground), 0.15);
    }

    .stats-line {
      display: flex;
      gap: 16px;
      padding-top: 8px;
      border-top: 1px solid var(--vscode-panel-border);
    }

    .stat-item {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
    }

    .stat-dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
    }

    .stat-item.staged .stat-dot {
      background: var(--vscode-gitDecoration-addedResourceForeground);
    }

    .stat-item.modified .stat-dot {
      background: var(--vscode-gitDecoration-modifiedResourceForeground);
    }

    .stat-text {
      font-weight: 500;
    }

    /* Minimalist Action Buttons */
    .actions-row {
      display: flex;
      gap: 6px;
      margin-bottom: 12px;
    }

    .action-btn {
      flex: 1;
      background: transparent;
      color: var(--vscode-foreground);
      border: 1px solid var(--vscode-panel-border);
      border-radius: 3px;
      padding: 7px 8px;
      font-size: 11px;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.15s ease;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 5px;
      position: relative;
    }

    .action-btn i {
      font-size: 13px;
      opacity: 0.8;
    }

    .action-btn:hover {
      background: var(--vscode-list-hoverBackground);
      border-color: var(--vscode-focusBorder);
    }

    .action-btn.primary {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border-color: var(--vscode-button-background);
    }

    .action-btn.primary:hover {
      background: var(--vscode-button-hoverBackground);
      border-color: var(--vscode-button-hoverBackground);
    }

    .action-btn:disabled {
      opacity: 0.5;
      cursor: not-allowed;
      pointer-events: none;
    }

    .action-btn.loading {
      pointer-events: none;
    }

    .action-btn.loading::after {
      content: '';
      position: absolute;
      width: 11px;
      height: 11px;
      border: 2px solid transparent;
      border-top-color: currentColor;
      border-radius: 50%;
      animation: spinner 0.6s linear infinite;
    }

    .action-btn.loading span {
      opacity: 0;
    }

    .action-btn.loading i {
      opacity: 0;
    }

    @keyframes spinner {
      to { transform: rotate(360deg); }
    }

    /* Commit Box */
    .commit-box {
      background: var(--vscode-editor-background);
      border: 1px solid var(--vscode-panel-border);
      border-radius: 4px;
      padding: 10px;
      margin-bottom: 12px;
    }

    .commit-box-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 8px;
    }

    .commit-label {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 11px;
      font-weight: 600;
      color: var(--vscode-foreground);
    }

    .commit-label i {
      font-size: 13px;
      opacity: 0.8;
    }

    .icon-btn {
      width: 24px;
      height: 24px;
      padding: 0;
      background: transparent;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 3px;
      color: var(--vscode-foreground);
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: all 0.15s ease;
    }

    .icon-btn:hover {
      background: var(--vscode-list-hoverBackground);
      border-color: var(--vscode-focusBorder);
    }

    .icon-btn i {
      font-size: 13px;
    }

    textarea {
      width: 100%;
      min-height: 70px;
      padding: 8px 10px;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border);
      border-radius: 3px;
      font-family: var(--vscode-font-family);
      font-size: 12px;
      resize: vertical;
      outline: none;
      line-height: 1.4;
    }

    textarea:focus {
      border-color: var(--vscode-focusBorder);
    }

    textarea::placeholder {
      color: var(--vscode-input-placeholderForeground);
      opacity: 0.6;
    }

    .commit-message-loader {
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      height: 2px;
      background: var(--vscode-progressBar-background);
      overflow: hidden;
      z-index: 10;
      border-radius: 3px 3px 0 0;
    }

    .commit-message-loader::before {
      content: '';
      position: absolute;
      top: 0;
      left: -100%;
      width: 100%;
      height: 100%;
      background: var(--vscode-focusBorder);
      animation: loadingSlide 1.5s ease-in-out infinite;
    }

    @keyframes loadingSlide {
      0% {
        left: -100%;
      }
      100% {
        left: 100%;
      }
    }

    .commit-actions-row {
      display: flex;
      gap: 6px;
      margin-top: 8px;
    }

    .commit-action-btn {
      flex: 1;
      padding: 8px 10px;
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      border: none;
      border-radius: 4px;
      cursor: pointer;
      font-family: inherit;
      font-size: 11px;
      font-weight: 500;
      position: relative;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 5px;
      transition: all 0.15s ease;
    }

    .commit-action-btn i {
      font-size: 13px;
    }

    .commit-action-btn:hover {
      background: var(--vscode-button-secondaryHoverBackground);
    }

    .commit-action-btn:active {
      transform: scale(0.97);
    }

    .commit-action-btn.primary {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
    }

    .commit-action-btn.primary:hover {
      background: var(--vscode-button-hoverBackground);
    }

    .commit-action-btn.loading::after {
      content: '';
      position: absolute;
      width: 12px;
      height: 12px;
      border: 2px solid transparent;
      border-top-color: currentColor;
      border-radius: 50%;
      animation: spinner 0.6s linear infinite;
    }

    .commit-action-btn.loading span {
      opacity: 0;
    }

    .commit-action-btn.loading i {
      opacity: 0;
    }

    .section {
      margin-bottom: 12px;
    }

    .section-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 7px 10px;
      background: var(--vscode-editor-background);
      border: 1px solid var(--vscode-panel-border);
      border-radius: 3px;
      cursor: pointer;
      transition: all 0.15s ease;
      margin-bottom: 4px;
      user-select: none;
    }

    .section-header:hover {
      background: var(--vscode-list-hoverBackground);
      border-color: var(--vscode-focusBorder);
    }

    .section-title {
      display: flex;
      align-items: center;
      gap: 6px;
      flex: 1;
    }

    .section-chevron {
      font-size: 11px;
      transition: transform 0.2s ease;
      color: var(--vscode-descriptionForeground);
      opacity: 0.8;
    }

    .section-header.collapsed .section-chevron {
      transform: rotate(-90deg);
    }

    .section-label {
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0.3px;
    }

    .section-count {
      font-size: 10px;
      color: var(--vscode-descriptionForeground);
      background: var(--vscode-badge-background);
      padding: 2px 5px;
      border-radius: 3px;
      font-weight: 600;
      min-width: 18px;
      text-align: center;
    }

    .section-actions {
      display: flex;
      gap: 4px;
      align-items: center;
    }

    .quick-action {
      padding: 3px 7px;
      border: none;
      border-radius: 3px;
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      cursor: pointer;
      font-size: 10px;
      font-weight: 500;
      white-space: nowrap;
      display: flex;
      align-items: center;
      gap: 3px;
      transition: all 0.15s ease;
    }

    .quick-action i {
      font-size: 11px;
    }

    .quick-action:hover {
      background: var(--vscode-button-secondaryHoverBackground);
    }

    .quick-action:active {
      transform: scale(0.96);
    }

    .section-content {
      max-height: 2000px;
      opacity: 1;
      overflow: hidden;
      transition: max-height 0.3s ease, opacity 0.2s ease;
    }

    .section-content.collapsed {
      max-height: 0;
      opacity: 0;
    }

    .list-item {
      background: var(--vscode-editor-background);
      border: 1px solid var(--vscode-panel-border);
      border-radius: 3px;
      padding: 6px 8px;
      margin-bottom: 3px;
      display: flex;
      align-items: center;
      gap: 8px;
      transition: all 0.15s ease;
    }

    .list-item:hover {
      background: var(--vscode-list-hoverBackground);
      border-color: var(--vscode-focusBorder);
    }

    .file-status-icon {
      flex-shrink: 0;
      font-size: 14px !important;
      opacity: 0.9;
    }

    .file-status-icon.staged { color: var(--vscode-gitDecoration-addedResourceForeground); }
    .file-status-icon.modified { color: var(--vscode-gitDecoration-modifiedResourceForeground); }
    .file-status-icon.untracked { color: var(--vscode-gitDecoration-untrackedResourceForeground); }
    .file-status-icon.deleted { color: var(--vscode-gitDecoration-deletedResourceForeground); }

    .file-info {
      flex: 1;
      min-width: 0;
      cursor: pointer;
    }

    .file-name {
      font-size: 12px;
      font-weight: 500;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      line-height: 1.4;
    }

    .file-path {
      font-size: 10px;
      color: var(--vscode-descriptionForeground);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      opacity: 0.7;
      margin-top: 1px;
    }

    .file-actions {
      display: none;
      gap: 3px;
      flex-shrink: 0;
    }

    .list-item:hover .file-actions {
      display: flex;
    }

    .file-action {
      width: 20px;
      height: 20px;
      border: none;
      border-radius: 3px;
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      cursor: pointer;
      font-size: 11px;
      font-weight: 600;
      transition: all 0.15s ease;
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .file-action:hover {
      background: var(--vscode-button-secondaryHoverBackground);
      transform: scale(1.05);
    }

    .file-action.danger:hover {
      background: var(--vscode-inputValidation-errorBackground);
      color: var(--vscode-errorForeground);
    }

    .empty-state {
      text-align: center;
      padding: 48px 20px;
      color: var(--vscode-descriptionForeground);
    }

    .empty-state-icon {
      font-size: 40px;
      opacity: 0.5;
      margin-bottom: 12px;
    }

    .empty-state h3 {
      font-size: 14px;
      font-weight: 600;
      margin-bottom: 6px;
      color: var(--vscode-foreground);
    }

    .empty-state p {
      font-size: 12px;
      line-height: 1.5;
    }

    .warning-box {
      background: var(--vscode-inputValidation-warningBackground);
      border: 1px solid var(--vscode-inputValidation-warningBorder);
      border-left: 3px solid var(--vscode-inputValidation-warningBorder);
      border-radius: 2px;
      padding: 10px 12px;
      margin-bottom: 16px;
      font-size: 12px;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    `;
  }

  private _getBranchesStyles(): string {
    return `
    .input-container {
      background: var(--vscode-editor-background);
      border: 1px solid var(--vscode-panel-border);
      border-radius: 6px;
      padding: 10px;
      margin-bottom: 16px;
      display: flex;
      gap: 8px;
      transition: all 0.15s ease;
    }

    .input-container:focus-within {
      background: var(--vscode-list-hoverBackground);
      border-color: var(--vscode-focusBorder);
    }

    input {
      flex: 1;
      padding: 6px 8px;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border);
      border-radius: 4px;
      font-family: inherit;
      font-size: 12px;
      outline: none;
    }

    input:focus {
      border-color: var(--vscode-focusBorder);
    }

    .add-btn {
      padding: 6px 14px;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: 1px solid var(--vscode-button-background);
      border-radius: 4px;
      cursor: pointer;
      font-family: inherit;
      font-size: 12px;
      font-weight: 500;
      white-space: nowrap;
      position: relative;
      transition: all 0.15s ease;
    }

    .add-btn:hover {
      background: var(--vscode-button-hoverBackground);
      border-color: var(--vscode-button-hoverBackground);
    }

    .add-btn:active {
      transform: scale(0.96);
    }

    .add-btn:disabled {
      opacity: 0.5;
      cursor: not-allowed;
      pointer-events: none;
    }

    .add-btn.loading::after {
      content: '';
      position: absolute;
      width: 12px;
      height: 12px;
      left: 50%;
      top: 50%;
      margin-top: -6px;
      margin-left: -6px;
      border: 2px solid transparent;
      border-top-color: currentColor;
      border-radius: 50%;
      animation: spinner 0.6s linear infinite;
    }

    .add-btn.loading {
      color: transparent;
    }

    .list-item.active {
      border-color: var(--vscode-focusBorder);
      background: var(--vscode-list-hoverBackground);
      cursor: default;
    }

    .list-item.active:hover {
      cursor: default;
    }

    .branch-icon {
      flex-shrink: 0;
      opacity: 0.9;
      font-size: 14px;
    }

    .branch-name {
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: 12px;
      font-weight: 500;
    }

    .branch-actions {
      display: none;
      gap: 4px;
      flex-shrink: 0;
    }

    .list-item:hover .branch-actions {
      display: flex;
    }

    .branch-actions button {
      padding: 4px 8px;
      border: 1px solid var(--vscode-button-border);
      border-radius: 4px;
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      cursor: pointer;
      font-size: 10px;
      font-weight: 500;
      transition: all 0.15s ease;
    }

    .branch-actions button:hover {
      background: var(--vscode-button-secondaryHoverBackground);
    }

    .badge {
      padding: 3px 8px;
      border-radius: 10px;
      font-size: 9px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
      white-space: nowrap;
      display: flex;
      align-items: center;
      justify-content: center;
      margin-left: auto;
    }
    `;
  }

  private _getCommitsStyles(): string {
    return `
    .header {
      background: var(--vscode-editor-background);
      border: 1px solid var(--vscode-panel-border);
      border-radius: 4px;
      padding: 8px 10px;
      margin-bottom: 12px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 8px;
    }

    .branch-info {
      font-size: 11px;
      color: var(--vscode-foreground);
      display: flex;
      align-items: center;
      gap: 6px;
      font-weight: 600;
    }

    .branch-info i {
      opacity: 0.8;
      font-size: 13px;
    }

    .branch-name {
      font-weight: 600;
      color: var(--vscode-foreground);
    }

    .refresh-btn {
      padding: 5px 8px;
      border: none;
      border-radius: 3px;
      font-size: 10px;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.15s ease;
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      position: relative;
      display: flex;
      align-items: center;
      gap: 4px;
    }

    .refresh-btn i {
      font-size: 12px;
    }

    .refresh-btn:hover {
      background: var(--vscode-button-secondaryHoverBackground);
    }

    .refresh-btn:active {
      transform: scale(0.96);
    }

    .refresh-btn.loading::after {
      content: '';
      position: absolute;
      width: 12px;
      height: 12px;
      top: 50%;
      left: 50%;
      margin-top: -6px;
      margin-left: -6px;
      border: 2px solid transparent;
      border-top-color: currentColor;
      border-radius: 50%;
      animation: spinner 0.6s linear infinite;
    }

    .refresh-btn.loading {
      color: transparent;
    }

    .commit-list {
      margin-bottom: 16px;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }

    .commit-item {
      background: var(--vscode-editor-background);
      border: 1px solid var(--vscode-panel-border);
      border-radius: 4px;
      padding: 10px;
      cursor: pointer;
      transition: all 0.15s ease;
      position: relative;
    }

    .commit-item:hover {
      background: var(--vscode-list-hoverBackground);
      border-color: var(--vscode-focusBorder);
    }

    .commit-item:active {
      transform: scale(0.99);
    }

    .commit-header {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 6px;
    }

    .commit-hash {
      font-family: var(--vscode-editor-font-family), 'Consolas', 'Courier New', monospace;
      font-size: 10px;
      font-weight: 600;
      color: var(--vscode-textPreformat-foreground);
      background: var(--vscode-textCodeBlock-background);
      padding: 2px 6px;
      border-radius: 3px;
      border: 1px solid var(--vscode-panel-border);
    }

    .commit-date {
      font-size: 10px;
      color: var(--vscode-descriptionForeground);
      font-weight: 500;
    }

    .commit-message {
      font-size: 12px;
      margin-bottom: 6px;
      line-height: 1.5;
      font-weight: 500;
      color: var(--vscode-foreground);
    }

    .commit-footer {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      flex-wrap: wrap;
    }

    .commit-author {
      font-size: 10px;
      color: var(--vscode-descriptionForeground);
      display: flex;
      align-items: center;
      gap: 3px;
    }

    .commit-author::before {
      content: '•';
      font-size: 10px;
      opacity: 0.6;
    }

    .commit-refs {
      display: flex;
      flex-wrap: wrap;
      gap: 3px;
    }

    .ref-badge {
      display: inline-flex;
      align-items: center;
      gap: 2px;
      padding: 2px 5px;
      background: var(--vscode-badge-background);
      border-radius: 3px;
      font-size: 9px;
      font-weight: 600;
      white-space: nowrap;
      color: var(--vscode-badge-foreground);
      border: 1px solid transparent;
      line-height: 1.2;
    }

    .ref-badge i {
      font-size: 9px;
    }

    .ref-badge.head {
      background: rgba(var(--vscode-gitDecoration-modifiedResourceForeground), 0.15);
      color: var(--vscode-gitDecoration-modifiedResourceForeground);
      border-color: rgba(var(--vscode-gitDecoration-modifiedResourceForeground), 0.25);
    }

    .ref-badge.main {
      background: rgba(var(--vscode-gitDecoration-addedResourceForeground), 0.15);
      color: var(--vscode-gitDecoration-addedResourceForeground);
      border-color: rgba(var(--vscode-gitDecoration-addedResourceForeground), 0.25);
    }

    .ref-badge.origin {
      background: var(--vscode-badge-background);
      color: var(--vscode-descriptionForeground);
      border-color: var(--vscode-panel-border);
    }

    .load-more {
      text-align: center;
    }

    .load-more-btn {
      padding: 10px 20px;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: 1px solid var(--vscode-button-background);
      border-radius: 6px;
      cursor: pointer;
      font-family: inherit;
      font-size: 12px;
      font-weight: 500;
      position: relative;
      transition: all 0.15s ease;
      display: inline-flex;
      align-items: center;
      gap: 6px;
    }

    .load-more-btn:hover {
      background: var(--vscode-button-hoverBackground);
      border-color: var(--vscode-button-hoverBackground);
    }

    .load-more-btn:active {
      transform: scale(0.98);
    }

    .load-more-btn.loading::after {
      content: '';
      position: absolute;
      width: 12px;
      height: 12px;
      top: 50%;
      left: 50%;
      margin-top: -6px;
      margin-left: -6px;
      border: 2px solid transparent;
      border-top-color: currentColor;
      border-radius: 50%;
      animation: spinner 0.6s linear infinite;
    }

    .load-more-btn.loading {
      color: transparent;
    }
    `;
  }

  private _getScrollbarStyles(): string {
    return `
    ::-webkit-scrollbar {
      width: 10px;
      height: 10px;
    }

    ::-webkit-scrollbar-track {
      background: transparent;
    }

    ::-webkit-scrollbar-thumb {
      background: var(--vscode-scrollbarSlider-background);
      border-radius: 0;
    }

    ::-webkit-scrollbar-thumb:hover {
      background: var(--vscode-scrollbarSlider-hoverBackground);
    }

    ::-webkit-scrollbar-thumb:active {
      background: var(--vscode-scrollbarSlider-activeBackground);
    }

    * {
      scrollbar-width: thin;
      scrollbar-color: var(--vscode-scrollbarSlider-background) transparent;
    }
    `;
  }

  private _getAllScripts(): string {
    return `
    const vscode = acquireVsCodeApi();
    let currentTab = '${this._activeTab}';

    // Tab switching - pure client-side, no reload needed
    function switchTab(tab) {
      currentTab = tab;
      
      // Update UI immediately - smooth transition without reload
      document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
      document.querySelectorAll('.tab-pane').forEach(pane => pane.classList.remove('active'));
      
      // Find and activate the selected tab button using data attribute
      const activeBtn = document.querySelector(\`.tab-btn[data-tab="\${tab}"]\`);
      const activePane = document.getElementById(\`\${tab}-tab\`);
      
      if (activeBtn) {
        activeBtn.classList.add('active');
      }
      if (activePane) {
        activePane.classList.add('active');
      }
      
      // Notify extension for state persistence (non-blocking)
      vscode.postMessage({ type: 'switchTab', tab });
    }

    // Listen for messages from extension
    window.addEventListener('message', event => {
      const message = event.data;
      if (message.type === 'clearLoading' && message.buttonId) {
        clearLoading(message.buttonId);
      } else if (message.type === 'clearAllLoading') {
        ['pushBtn', 'pullBtn', 'fetchBtn', 'refreshBtn', 'commitBtn', 'commitPushBtn', 'loadMoreBtn', 'addBtn', 'generateMsgBtn'].forEach(id => {
          clearLoading(id);
        });
      } else if (message.type === 'commitMessageGenerated') {
        const textarea = document.getElementById('commitMessage');
        if (textarea && message.message) {
          textarea.value = message.message;
          textarea.focus();
          // Move cursor to end
          textarea.setSelectionRange(textarea.value.length, textarea.value.length);
        }
      }
    });

    // Loading helpers
    function showLoading(buttonId) {
      const btn = document.getElementById(buttonId);
      if (!btn) return;
      
      // Special handling for generate button - show stop icon and loader
      if (buttonId === 'generateMsgBtn') {
        const icon = btn.querySelector('i');
        if (icon) {
          icon.className = 'codicon codicon-stop';
          btn.title = 'Stop generation';
          btn.onclick = function() { stopGeneration(); };
        }
        // Show loader animation
        const loader = document.getElementById('commitMessageLoader');
        if (loader) {
          loader.style.display = 'block';
        }
        // Don't disable the button so stop can work
      } else {
        btn.disabled = true;
      }
      btn.classList.add('loading');
    }

    function clearLoading(buttonId) {
      const btn = document.getElementById(buttonId);
      if (!btn) return;
      
      // Special handling for generate button - restore sparkle icon and hide loader
      if (buttonId === 'generateMsgBtn') {
        const icon = btn.querySelector('i');
        if (icon) {
          icon.className = 'codicon codicon-sparkle';
          btn.title = 'Generate commit message';
          btn.onclick = function() { fillCommitMessage(); };
        }
        // Hide loader animation
        const loader = document.getElementById('commitMessageLoader');
        if (loader) {
          loader.style.display = 'none';
        }
      }
      
      if (buttonId !== 'generateMsgBtn') {
        btn.disabled = false;
      }
      btn.classList.remove('loading');
    }
    
    // Stop generation function
    function stopGeneration() {
      vscode.postMessage({ type: 'stopGeneration' });
      clearLoading('generateMsgBtn');
    }

    function setLoading(elementId, isLoading) {
      const element = document.getElementById(elementId);
      if (!element) return;
      if (isLoading) {
        element.disabled = true;
        element.classList.add('loading');
      } else {
        element.disabled = false;
        element.classList.remove('loading');
      }
    }

    // Section collapse/expand
    function toggleSection(sectionName) {
      const header = document.getElementById(sectionName + '-header');
      const content = document.getElementById(sectionName + '-content');
      if (header && content) {
        header.classList.toggle('collapsed');
        content.classList.toggle('collapsed');
      }
    }

    // Auto-generate commit message based on staged files
    function generateCommitMessage() {
      const stagedItems = Array.from(document.querySelectorAll('.list-item[data-status="staged"]'));
      const files = stagedItems.map(item => item.getAttribute('data-file'));
      
      if (files.length === 0) {
        return 'chore: update files';
      }
      
      // Categorize files by conventional commit type
      const categories = {
        feat: [], fix: [], docs: [], style: [], 
        test: [], chore: [], refactor: []
      };
      
      // Get all untracked files to determine if staged files are new
      const allUntracked = Array.from(document.querySelectorAll('.list-item[data-status="untracked"]'))
        .map(item => item.getAttribute('data-file'));
      
      files.forEach(file => {
        const filename = file.split('/').pop();
        // A staged file is "new" if it was originally untracked
        const isNew = allUntracked.includes(file);
        
        if (file.match(/test|spec/i)) {
          categories.test.push(filename);
        } else if (file.match(/[.]md$/i)) {
          categories.docs.push(filename);
        } else if (file.match(/[.](css|scss|less)$/i)) {
          categories.style.push(filename);
        } else if (file.match(/package[.]json|tsconfig|config|[.]jsonc$/i)) {
          categories.chore.push(filename);
        } else if (isNew && file.match(/src|component|feature|page/i)) {
          categories.feat.push(filename);
        } else if (!isNew) {
          categories.fix.push(filename);
        } else {
          categories.refactor.push(filename);
        }
      });
      
      // Build message from first non-empty category
      let message = '';
      for (const [type, fileList] of Object.entries(categories)) {
        if (fileList.length > 0) {
          const fileNames = fileList.slice(0, 3).join(', ');
          const extra = fileList.length > 3 ? \` +\${fileList.length - 3} more\` : '';
          message = \`\${type}: \${fileNames}\${extra}\`;
          break;
        }
      }
      
      return message || 'chore: update files';
    }

    function fillCommitMessage() {
      const textarea = document.getElementById('commitMessage');
      if (!textarea) return;
      
      // Show loading on the generate button (will show stop icon)
      showLoading('generateMsgBtn');
      
      // Request detailed message from extension (uses LM if available)
      vscode.postMessage({ type: 'generateCommitMessage' });
    }
    
    // Auto-generate basic fallback message (without LM)
    function autoFillBasicMessage() {
      const textarea = document.getElementById('commitMessage');
      if (!textarea) return;
      
      const generated = generateCommitMessage();
      textarea.value = generated;
      textarea.focus();
      // Move cursor to end
      textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    }

    // Keyboard shortcuts for commit
    function handleCommitKeyboard(event) {
      if (event.ctrlKey && event.key === 'Enter') {
        event.preventDefault();
        commitAndPushWithLoading();
      } else if (event.ctrlKey && event.key === 's') {
        event.preventDefault();
        commitOnlyWithLoading();
      }
    }

    // Changes tab functions
    function refresh() {
      vscode.postMessage({ type: 'refresh' });
    }

    function refreshWithLoading() {
      showLoading('refreshBtn');
      refresh();
    }

    function stageFile(file) {
      vscode.postMessage({ type: 'stageFile', file });
    }

    function unstageFile(file) {
      vscode.postMessage({ type: 'unstageFile', file });
    }

    function unstageAll() {
      const stagedItems = Array.from(document.querySelectorAll('.list-item[data-status="staged"]'));
      stagedItems.forEach(item => {
        const file = item.getAttribute('data-file');
        if (file) {
          unstageFile(file);
        }
      });
    }

    function stageAll() {
      vscode.postMessage({ type: 'stageAll' });
    }

    function commitOnly() {
      const textarea = document.getElementById('commitMessage');
      if (!textarea) return;
      const message = textarea.value.trim();
      if (message) {
        vscode.postMessage({ type: 'commit', message });
      }
    }

    function commitOnlyWithLoading() {
      const textarea = document.getElementById('commitMessage');
      if (!textarea) return;
      const message = textarea.value.trim();
      if (message) {
        showLoading('commitBtn');
        commitOnly();
      }
    }

    function commitAndPush() {
      const textarea = document.getElementById('commitMessage');
      if (!textarea) return;
      const message = textarea.value.trim();
      if (message) {
        vscode.postMessage({ type: 'commitAndPush', message });
      }
    }

    function commitAndPushWithLoading() {
      const textarea = document.getElementById('commitMessage');
      if (!textarea) return;
      const message = textarea.value.trim();
      if (message) {
        showLoading('commitPushBtn');
        commitAndPush();
      }
    }

    function push() {
      vscode.postMessage({ type: 'push' });
    }

    function pushWithLoading() {
      showLoading('pushBtn');
      push();
    }

    function pull() {
      vscode.postMessage({ type: 'pull' });
    }

    function pullWithLoading() {
      showLoading('pullBtn');
      pull();
    }

    function fetch() {
      vscode.postMessage({ type: 'fetch' });
    }

    function fetchWithLoading() {
      showLoading('fetchBtn');
      fetch();
    }

    function discardFile(file) {
      vscode.postMessage({ type: 'discard', file });
    }

    function openDiff(file) {
      vscode.postMessage({ type: 'openDiff', file });
    }

    // Branches tab functions
    function createNewBranch() {
      const input = document.getElementById('newBranchName');
      const name = input.value.trim();
      if (name) {
        vscode.postMessage({ type: 'createBranch', name });
        input.value = '';
      }
    }

    function createNewBranchWithLoading() {
      const input = document.getElementById('newBranchName');
      const name = input.value.trim();
      if (name) {
        input.disabled = true;
        setLoading('addBtn', true);
        createNewBranch();
      }
    }

    function switchToBranch(name) {
      vscode.postMessage({ type: 'switchBranch', name });
    }

    function switchToBranchWithLoading(name) {
      const branchId = 'branch-' + name.replace(/[^a-zA-Z0-9]/g, '-');
      setLoading(branchId, true);
      switchToBranch(name);
    }

    function removeBranch(name) {
      vscode.postMessage({ type: 'deleteBranch', name });
    }

    function removeBranchWithLoading(name) {
      const branchId = 'branch-' + name.replace(/[^a-zA-Z0-9]/g, '-');
      setLoading(branchId, true);
      removeBranch(name);
    }

    // Commits tab functions
    function loadMore() {
      vscode.postMessage({ type: 'loadMore' });
    }

    function loadMoreWithLoading() {
      setLoading('loadMoreBtn', true);
      loadMore();
    }

    function openCommitDiff(hash) {
      vscode.postMessage({ type: 'openCommitDiff', hash });
    }

    // Auto-populate commit message on page load if textarea is empty and files are staged
    // Use basic fallback (not LM) to avoid consuming API quota
    window.addEventListener('DOMContentLoaded', () => {
      const textarea = document.getElementById('commitMessage');
      const stagedItems = document.querySelectorAll('.list-item[data-status="staged"]');
      
      if (textarea && stagedItems.length > 0 && !textarea.value.trim()) {
        autoFillBasicMessage();
      }
    });
  </script>
</body>
</html>`;
  }
}