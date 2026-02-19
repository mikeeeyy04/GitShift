/**
 * GitShift - Git Manager Module
 * Copyright (c) 2025 mikeeeyy04
 * https://github.com/mikeeeyy04/GitShift
 * 
 * MIT License - See LICENSE file for details
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import * as vscode from 'vscode';
import { GitUser } from './types';

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
 * Executes a git command in the workspace
 */
async function executeGitCommand(command: string): Promise<string> {
  const workspaceRoot = getWorkspaceRoot();
  if (!workspaceRoot) {
    throw new Error('No workspace folder is open');
  }

  try {
    const { stdout } = await execPromise(command, {
      cwd: workspaceRoot,
      encoding: 'utf8',
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
    });

    return stdout.trim();
  } catch (error: any) {
    throw new Error(`Git command failed: ${error.message || 'Unknown error'}`);
  }
}

/**
 * Gets the current git user configuration
 */
export async function getCurrentGitUser(): Promise<GitUser | null> {
  try {
    const name = await executeGitCommand('git config user.name');
    const email = await executeGitCommand('git config user.email');

    if (!name || !email) {
      return null;
    }

    return { name, email };
  } catch (error) {
    return null;
  }
}

/**
 * Sets the git user configuration for the current workspace
 */
export async function setGitUser(name: string, email: string): Promise<void> {
  try {
    await executeGitCommand(`git config user.name "${name}"`);
    await executeGitCommand(`git config user.email "${email}"`);
  } catch (error: any) {
    throw new Error(`Failed to set git user: ${error.message}`);
  }
}

/**
 * Gets the git remote URL
 */
export async function getGitRemoteUrl(): Promise<string | null> {
  try {
    const url = await executeGitCommand('git config --get remote.origin.url');
    return url || null;
  } catch (error) {
    return null;
  }
}

/**
 * Checks if the current workspace is a git repository
 */
export async function isGitRepository(): Promise<boolean> {
  try {
    await executeGitCommand('git rev-parse --git-dir');
    return true;
  } catch (error) {
    return false;
  }
}

