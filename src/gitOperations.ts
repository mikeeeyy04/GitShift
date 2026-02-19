import { exec } from 'child_process';
import { promisify } from 'util';
import * as vscode from 'vscode';

const execAsync = promisify(exec);

export interface Branch {
    name: string;
    current: boolean;
    remote?: boolean;
}

export interface CommitInfo {
    hash: string;
    message: string;
    author: string;
    date: string;
    refs?: string;  // Branch/tag references
}

export interface GitStatus {
    branch: string;
    ahead: number;
    behind: number;
    staged: string[];
    unstaged: string[];
    untracked: string[];
}

/**
 * Execute a Git command in the workspace
 */
async function executeGitCommand(command: string): Promise<string> {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
        throw new Error('No workspace folder open');
    }

    const cwd = workspaceFolders[0].uri.fsPath;

    try {
        const { stdout } = await execAsync(`git ${command}`, {
            cwd,
            env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
        });
        return stdout.trim();
    } catch (error: any) {
        throw new Error(`Git command failed: ${error.message}`);
    }
}

/**
 * Get all branches (local and remote)
 */
export async function getBranches(): Promise<Branch[]> {
    try {
        const output = await executeGitCommand('branch -a');
        const lines = output.split('\n').filter(line => line.trim());

        const branches: Branch[] = [];
        for (const line of lines) {
            const isCurrent = line.startsWith('*');
            const branchName = line.replace('*', '').trim();

            if (branchName.includes('remotes/origin/')) {
                const remoteName = branchName.replace('remotes/origin/', '');
                if (remoteName !== 'HEAD') {
                    branches.push({
                        name: remoteName,
                        current: false,
                        remote: true
                    });
                }
            } else {
                branches.push({
                    name: branchName,
                    current: isCurrent,
                    remote: false
                });
            }
        }

        return branches;
    } catch (error) {
        return [];
    }
}

/**
 * Get current branch name
 */
export async function getCurrentBranch(): Promise<string> {
    try {
        return await executeGitCommand('branch --show-current');
    } catch (error) {
        return 'unknown';
    }
}

/**
 * Create a new branch
 */
export async function createBranch(branchName: string): Promise<void> {
    await executeGitCommand(`branch ${branchName}`);
}

/**
 * Switch to a branch
 */
export async function checkoutBranch(branchName: string): Promise<void> {
    await executeGitCommand(`checkout ${branchName}`);
}

/**
 * Delete a branch
 */
export async function deleteBranch(branchName: string, force: boolean = false): Promise<void> {
    const flag = force ? '-D' : '-d';
    await executeGitCommand(`branch ${flag} ${branchName}`);
}

/**
 * Get commit history
 */
export async function getCommitHistory(limit: number = 10): Promise<CommitInfo[]> {
    try {
        // Include --decorate to get branch/tag references
        const format = '%H|%s|%an|%ar|%D';
        const output = await executeGitCommand(`log -${limit} --pretty=format:"${format}" --all`);

        const commits: CommitInfo[] = [];
        const lines = output.split('\n').filter(line => line.trim());

        for (const line of lines) {
            const parts = line.replace(/"/g, '').split('|');
            if (parts.length >= 4) {
                commits.push({
                    hash: parts[0],  // Keep full hash
                    message: parts[1],
                    author: parts[2],
                    date: parts[3],
                    refs: parts[4] || ''  // Branch/tag references
                });
            }
        }

        return commits;
    } catch (error) {
        return [];
    }
}

/**
 * Get Git status
 */
export async function getGitStatus(): Promise<GitStatus> {
    try {
        const branch = await getCurrentBranch();
        const statusOutput = await executeGitCommand('status --porcelain=v1 -b');

        const lines = statusOutput.split('\n');
        const branchLine = lines[0] || '';

        // Parse ahead/behind
        let ahead = 0;
        let behind = 0;
        const aheadMatch = branchLine.match(/ahead (\d+)/);
        const behindMatch = branchLine.match(/behind (\d+)/);
        if (aheadMatch) ahead = parseInt(aheadMatch[1]);
        if (behindMatch) behind = parseInt(behindMatch[1]);

        const staged: string[] = [];
        const unstaged: string[] = [];
        const untracked: string[] = [];

        for (let i = 1; i < lines.length; i++) {
            const line = lines[i];
            if (!line) continue;

            const status = line.substring(0, 2);
            const file = line.substring(3);

            if (status[0] !== ' ' && status[0] !== '?') {
                staged.push(file);
            }
            if (status[1] !== ' ' && status[1] !== '?') {
                unstaged.push(file);
            }
            if (status === '??') {
                untracked.push(file);
            }
        }

        return { branch, ahead, behind, staged, unstaged, untracked };
    } catch (error) {
        return {
            branch: 'unknown',
            ahead: 0,
            behind: 0,
            staged: [],
            unstaged: [],
            untracked: []
        };
    }
}

/**
 * Stage files
 */
export async function stageFiles(files: string[]): Promise<void> {
    if (files.length === 0) return;
    const fileList = files.map(f => `"${f}"`).join(' ');
    await executeGitCommand(`add ${fileList}`);
}

/**
 * Stage all files
 */
export async function stageAll(): Promise<void> {
    await executeGitCommand('add -A');
}

/**
 * Unstage files
 */
export async function unstageFiles(files: string[]): Promise<void> {
    if (files.length === 0) return;
    const fileList = files.map(f => `"${f}"`).join(' ');
    await executeGitCommand(`reset HEAD ${fileList}`);
}

/**
 * Commit staged changes
 */
export async function commit(message: string): Promise<void> {
    if (!message || !message.trim()) {
        throw new Error('Commit message cannot be empty');
    }
    const escapedMessage = message.replace(/"/g, '\\"');
    await executeGitCommand(`commit -m "${escapedMessage}"`);
}

/**
 * Push to remote
 */
export async function push(branch?: string): Promise<void> {
    if (branch) {
        // Set upstream branch when pushing specific branch
        await executeGitCommand(`push -u origin ${branch}`);
    } else {
        // Get current branch and set upstream
        const currentBranch = await getCurrentBranch();
        if (currentBranch && currentBranch !== 'unknown') {
            await executeGitCommand(`push -u origin ${currentBranch}`);
        } else {
            // Fallback to regular push
            await executeGitCommand('push');
        }
    }
}

/**
 * Pull from remote
 */
export async function pull(): Promise<void> {
    await executeGitCommand('pull');
}

/**
 * Fetch from remote
 */
export async function fetch(): Promise<void> {
    await executeGitCommand('fetch');
}

/**
 * Discard changes in files
 */
export async function discardChanges(files: string[]): Promise<void> {
    if (files.length === 0) return;
    const fileList = files.map(f => `"${f}"`).join(' ');
    await executeGitCommand(`checkout -- ${fileList}`);
}

/**
 * Get diff for a file (unstaged changes)
 */
export async function getFileDiff(file: string): Promise<string> {
    try {
        return await executeGitCommand(`diff "${file}"`);
    } catch (error) {
        return '';
    }
}

/**
 * Get staged diff for a file
 */
export async function getStagedFileDiff(file: string): Promise<string> {
    try {
        return await executeGitCommand(`diff --cached "${file}"`);
    } catch (error) {
        return '';
    }
}

/**
 * Stash changes
 */
export async function stash(message?: string): Promise<void> {
    if (message) {
        await executeGitCommand(`stash push -m "${message}"`);
    } else {
        await executeGitCommand('stash');
    }
}

/**
 * Apply stash
 */
export async function stashPop(): Promise<void> {
    await executeGitCommand('stash pop');
}

/**
 * List stashes
 */
export async function getStashes(): Promise<string[]> {
    try {
        const output = await executeGitCommand('stash list');
        return output.split('\n').filter(line => line.trim());
    } catch (error) {
        return [];
    }
}

/**
 * Sync - Pull then Push
 */
export async function sync(): Promise<void> {
    await pull();
    await push();
}

/**
 * Pull with rebase
 */
export async function pullRebase(): Promise<void> {
    await executeGitCommand('pull --rebase');
}

/**
 * Force push
 */
export async function pushForce(): Promise<void> {
    await executeGitCommand('push --force-with-lease');
}

/**
 * Merge branch
 */
export async function mergeBranch(branchName: string): Promise<void> {
    await executeGitCommand(`merge ${branchName}`);
}

/**
 * Rebase branch
 */
export async function rebaseBranch(branchName: string): Promise<void> {
    await executeGitCommand(`rebase ${branchName}`);
}

/**
 * Discard all changes
 */
export async function discardAllChanges(): Promise<void> {
    await executeGitCommand('reset --hard HEAD');
    await executeGitCommand('clean -fd');
}

/**
 * Amend last commit
 */
export async function amendCommit(message?: string): Promise<void> {
    if (message) {
        const escapedMessage = message.replace(/"/g, '\\"');
        await executeGitCommand(`commit --amend -m "${escapedMessage}"`);
    } else {
        await executeGitCommand('commit --amend --no-edit');
    }
}

/**
 * Undo last commit (soft reset)
 */
export async function undoLastCommit(): Promise<void> {
    await executeGitCommand('reset --soft HEAD~1');
}

/**
 * Initialize repository
 */
export async function initRepository(): Promise<void> {
    await executeGitCommand('init');
}

/**
 * Clone repository
 */
export async function cloneRepository(url: string, directory: string): Promise<void> {
    await executeGitCommand(`clone "${url}" "${directory}"`);
}

/**
 * Get remotes
 */
export async function getRemotes(): Promise<string[]> {
    try {
        const output = await executeGitCommand('remote -v');
        return output.split('\n').filter(line => line.trim());
    } catch (error) {
        return [];
    }
}

/**
 * Add remote
 */
export async function addRemote(name: string, url: string): Promise<void> {
    await executeGitCommand(`remote add ${name} "${url}"`);
}

/**
 * Remove remote
 */
export async function removeRemote(name: string): Promise<void> {
    await executeGitCommand(`remote remove ${name}`);
}

/**
 * Get git log for graph visualization
 */
export async function getGitLog(limit: number = 50): Promise<string> {
    try {
        return await executeGitCommand(`log --graph --oneline --decorate --all -${limit}`);
    } catch (error) {
        return '';
    }
}

