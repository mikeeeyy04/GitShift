import { exec } from 'child_process';
import { promisify } from 'util';
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const execPromise = promisify(exec);

/**
 * Gets the workspace root path
 */
function getWorkspaceRoot(): string | undefined {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    return workspaceFolders && workspaceFolders.length > 0
        ? workspaceFolders[0].uri.fsPath
        : undefined;
}

/**
 * Gets the path to Git's credential store file
 */
function getCredentialStorePath(): string {
    const homeDir = os.homedir();
    if (process.platform === 'win32') {
        return path.join(homeDir, '.git-credentials');
    }
    return path.join(homeDir, '.git-credentials');
}

/**
 * Stores credentials in Git's credential store securely
 */
async function storeCredentialsInGitStore(username: string, token: string): Promise<void> {
    try {
        const credentialStorePath = getCredentialStorePath();
        const credentialLine = `https://${username}:${token}@github.com\n`;
        
        // Read existing credentials
        let existingCredentials = '';
        if (fs.existsSync(credentialStorePath)) {
            existingCredentials = fs.readFileSync(credentialStorePath, 'utf8');
        }

        // Remove any existing entry for github.com with this username
        const lines = existingCredentials.split('\n').filter(line => {
            // Remove lines that match this username for github.com
            return !(line.includes('github.com') && line.includes(username));
        });

        // Add the new credential
        lines.push(credentialLine.trim());

        // Write back to file
        fs.writeFileSync(credentialStorePath, lines.join('\n') + '\n', { mode: 0o600 });
    } catch (error: any) {
        // If we can't write to the credential store, fall back to URL embedding
        // This is handled by the calling code
        console.warn(`Failed to store credentials in Git credential store: ${error.message}`);
        throw error;
    }
}

/**
 * Configures git to use a credential helper with the provided token
 * Also stores credentials in Git's credential store
 */
export async function configureGitCredentials(username: string, token: string): Promise<void> {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) {
        throw new Error('No workspace folder is open');
    }

    try {
        // Configure git credential helper to store credentials
        await execPromise('git config --local credential.helper store', {
            cwd: workspaceRoot
        });

        // Store credentials in Git's credential store
        await storeCredentialsInGitStore(username, token);
    } catch (error: any) {
        // If credential store fails, we'll fall back to URL embedding
        // Don't throw - let the calling code handle it
        console.warn(`Failed to configure git credentials: ${error.message}`);
    }
}

/**
 * Updates the git remote URL to use HTTPS WITHOUT embedded token (secure)
 * Credentials are stored separately in Git's credential store
 */
export async function updateRemoteUrlWithToken(remoteName: string, token: string, username: string): Promise<void> {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) {
        throw new Error('No workspace folder is open');
    }

    try {
        // First, ensure credentials are stored in Git's credential store
        await storeCredentialsInGitStore(username, token);

        // Get current remote URL
        const { stdout } = await execPromise(`git remote get-url ${remoteName}`, {
            cwd: workspaceRoot
        });

        const currentUrl = stdout.trim();

        // Parse the URL to extract owner/repo and create a CLEAN URL (no token embedded)
        // Include username so Git credential lookup is deterministic per selected account.
        let cleanUrl: string;

        if (currentUrl.startsWith('git@github.com:')) {
            // Convert SSH to HTTPS (clean, no token)
            const repoPath = currentUrl.replace('git@github.com:', '').replace('.git', '');
            cleanUrl = `https://${username}@github.com/${repoPath}.git`;
        } else if (currentUrl.includes('github.com')) {
            // Remove any embedded credentials and create clean URL
            // Handle URLs like: https://username:token@github.com/owner/repo.git
            let repoPath: string;
            
            if (currentUrl.includes('@github.com/')) {
                // Has embedded credentials - extract path after @github.com/
                repoPath = currentUrl.split('@github.com/')[1]?.replace('.git', '') || '';
            } else if (currentUrl.includes('github.com/')) {
                // No credentials, just extract path after github.com/
                repoPath = currentUrl.split('github.com/')[1]?.replace('.git', '') || '';
            } else {
                throw new Error('Could not parse repository URL');
            }

            if (repoPath) {
                cleanUrl = `https://${username}@github.com/${repoPath}.git`;
            } else {
                throw new Error('Could not parse repository URL');
            }
        } else {
            // Not a GitHub URL, skip
            return;
        }

        // Update the remote URL with CLEAN URL (credentials stored separately)
        await execPromise(`git remote set-url ${remoteName} "${cleanUrl}"`, {
            cwd: workspaceRoot
        });
    } catch (error: any) {
        // Don't throw - this is optional functionality
        console.warn(`Failed to update remote URL: ${error.message}`);
    }
}

/**
 * Gets the current git remote URL
 */
export async function getRemoteUrl(remoteName: string = 'origin'): Promise<string | null> {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) {
        return null;
    }

    try {
        const { stdout } = await execPromise(`git remote get-url ${remoteName}`, {
            cwd: workspaceRoot
        });
        return stdout.trim();
    } catch (error) {
        return null;
    }
}

/**
 * Parses a GitHub URL to extract owner and repo name
 */
export function parseGitHubUrl(url: string): { owner: string; repo: string } | null {
    try {
        // Handle SSH URLs: git@github.com:owner/repo.git
        if (url.startsWith('git@github.com:')) {
            const parts = url.replace('git@github.com:', '').replace('.git', '').split('/');
            if (parts.length === 2) {
                return { owner: parts[0], repo: parts[1] };
            }
        }

        // Handle HTTPS URLs: https://github.com/owner/repo.git
        if (url.includes('github.com/')) {
            const parts = url.split('github.com/')[1]?.replace('.git', '').split('/');
            if (parts && parts.length >= 2) {
                return { owner: parts[0], repo: parts[1] };
            }
        }

        return null;
    } catch (error) {
        return null;
    }
}

/**
 * Removes credentials from git remote URL
 */
export async function removeCredentialsFromRemote(remoteName: string = 'origin'): Promise<void> {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) {
        return;
    }

    try {
        const currentUrl = await getRemoteUrl(remoteName);
        if (!currentUrl) {
            return;
        }

        // Remove embedded credentials
        let cleanUrl = currentUrl;

        // Remove credentials from HTTPS URLs
        if (cleanUrl.includes('@github.com')) {
            const match = cleanUrl.match(/https:\/\/.*@github.com\/(.+)/);
            if (match) {
                cleanUrl = `https://github.com/${match[1]}`;
            }
        }

        if (cleanUrl !== currentUrl) {
            await execPromise(`git remote set-url ${remoteName} "${cleanUrl}"`, {
                cwd: workspaceRoot
            });
        }
    } catch (error) {
        // Silent failure - not critical
    }
}

/**
 * Migrates existing embedded credentials to Git credential store (one-time migration)
 * This cleans up any tokens that were previously embedded in remote URLs
 */
export async function migrateEmbeddedCredentials(): Promise<void> {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) {
        return;
    }

    try {
        const remoteUrl = await getRemoteUrl('origin');
        if (!remoteUrl || !remoteUrl.includes('github.com')) {
            return;
        }

        // Check if URL has embedded credentials (format: https://username:token@github.com/owner/repo.git)
        if (remoteUrl.includes('@github.com/') && remoteUrl.startsWith('https://')) {
            // Extract credentials from URL
            const match = remoteUrl.match(/https:\/\/([^:]+):([^@]+)@github\.com\/(.+)/);
            if (match) {
                const [, username, token, repoPath] = match;
                
                // Store credentials in Git credential store
                await storeCredentialsInGitStore(username, token);
                
                // Remove credentials from URL - preserve the exact path format
                let cleanPath = repoPath;
                // Clean up any trailing whitespace or issues
                cleanPath = cleanPath.trim();
                // Ensure proper format
                if (!cleanPath.endsWith('.git')) {
                    cleanPath = cleanPath.replace(/\/$/, ''); // Remove trailing slash if present
                }
                const cleanUrl = `https://${username}@github.com/${cleanPath}`;
                
                await execPromise(`git remote set-url origin "${cleanUrl}"`, {
                    cwd: workspaceRoot
                });
            }
        }
    } catch (error: any) {
        // Silent failure - migration is optional and shouldn't break the extension
        console.warn(`Failed to migrate embedded credentials: ${error.message}`);
    }
}
