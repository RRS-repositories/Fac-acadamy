import { mkdir, stat } from 'node:fs/promises';

// MEDIA_ROOT is the folder on the on-prem server that holds every recording
// and the video (decision D15). config/env.ts checks the VALUE — set, and an
// absolute path. This file checks the FOLDER, once, at start-up: it has to be
// there (or creatable) and it has to be a directory, because everything the
// academy serves as media comes out of it.
//
// It is deliberately not part of loadConfig: config parsing stays a pure
// function of the environment, so the config tests never touch a disk.

export interface MediaRootResult {
  root: string;
  created: boolean;
}

/**
 * Makes sure MEDIA_ROOT exists and is a folder, creating it if it is missing.
 * Throws a plain-English Error when it cannot: the entry point prints that and
 * refuses to start, the same as a missing environment variable.
 */
export async function ensureMediaRoot(root: string): Promise<MediaRootResult> {
  try {
    const info = await stat(root);
    if (!info.isDirectory()) {
      throw new Error(`MEDIA_ROOT is not a folder: ${root}`);
    }
    return { root, created: false };
  } catch (err) {
    if ((err as { code?: unknown }).code !== 'ENOENT') {
      if (err instanceof Error && err.message.startsWith('MEDIA_ROOT')) throw err;
      throw new Error(`MEDIA_ROOT could not be read (${(err as Error).message})`);
    }
  }

  try {
    await mkdir(root, { recursive: true });
  } catch (err) {
    throw new Error(`MEDIA_ROOT does not exist and could not be created: ${root}
  (${(err as Error).message})
  In production this folder is owned by the application user and lives OUTSIDE
  the website folder, so nothing can be fetched from it directly.`);
  }
  return { root, created: true };
}
