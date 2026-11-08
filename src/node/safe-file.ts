/*
 * Copyright 2026 MB AFKzona Group
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * File-system safety checks for files Rationale writes (the queue log and
 * its lock). Symlinks are refused, files are created with mode 0600, and a
 * file that other users can write to is refused.
 */

import { constants, type Stats } from 'node:fs';
import { lstat, open, type FileHandle } from 'node:fs/promises';
import { basename, dirname, isAbsolute, resolve } from 'node:path';
import { RationaleError } from '../errors.js';

/** O_NOFOLLOW where the platform has it (not on Windows). */
export const O_NOFOLLOW: number = (constants as Partial<typeof constants>).O_NOFOLLOW ?? 0;

/**
 * O_NONBLOCK where the platform has it. Opening a FIFO would otherwise block
 * until another process opens its other end; with it the open returns (or
 * fails) and the regular-file check refuses the FIFO. No effect on regular files.
 */
const O_NONBLOCK: number = (constants as Partial<typeof constants>).O_NONBLOCK ?? 0;

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,200}$/;

function uid(): number | undefined {
  return typeof process.getuid === 'function' ? process.getuid() : undefined;
}

async function lstatOrUndefined(path: string): Promise<Stats | undefined> {
  try {
    return await lstat(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw e;
  }
}

/**
 * Resolves a path for a file Rationale manages and checks it:
 * a plain file name (letters, digits, ".", "_", "-"), a real directory
 * that is not world-writable without the sticky bit, and, if the file
 * exists, a regular file owned by this user and not writable by others.
 */
export async function checkManagedPath(path: string): Promise<string> {
  if (typeof path !== 'string' || path === '' || path.includes('\0') || path.length > 4096) {
    throw new RationaleError('unsafe_path', 'Invalid file path.');
  }
  const full = isAbsolute(path) ? resolve(path) : resolve(process.cwd(), path);
  const name = basename(full);
  if (!SAFE_NAME.test(name)) throw new RationaleError('unsafe_path', 'The file name may contain only letters, digits, ".", "_" and "-".');
  const dir = dirname(full);
  const d = await lstatOrUndefined(dir);
  if (!d?.isDirectory()) throw new RationaleError('unsafe_path', 'The directory does not exist or is not a directory.');
  if (uid() !== undefined && (d.mode & 0o002) !== 0 && (d.mode & 0o1000) === 0) {
    throw new RationaleError('unsafe_path', 'The directory is writable by everyone. Use a private directory.');
  }
  const f = await lstatOrUndefined(full);
  if (f) checkExisting(f);
  return full;
}

/** Checks an existing file: regular, not a symlink, owned by us, not group/world-writable. */
export function checkExisting(f: Stats): void {
  if (f.isSymbolicLink()) throw new RationaleError('unsafe_path', 'The path is a symbolic link. Refusing to follow it.');
  if (!f.isFile()) throw new RationaleError('unsafe_path', 'The path exists and is not a regular file.');
  const me = uid();
  if (me !== undefined) {
    if (f.uid !== me) throw new RationaleError('unsafe_path', 'The file belongs to another user.');
    if ((f.mode & 0o022) !== 0) throw new RationaleError('unsafe_path', 'The file is writable by other users. Run chmod 600 on it.');
  }
}

/** Opens a file for appending: created with mode 0600 if missing, never through a symlink. */
export async function openAppend(path: string): Promise<FileHandle> {
  const fh = await open(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | O_NOFOLLOW | O_NONBLOCK, 0o600);
  try {
    checkExisting(await fh.stat());
  } catch (e) {
    await fh.close();
    throw e;
  }
  return fh;
}

/** Opens an existing file for reading, never through a symlink. */
export async function openRead(path: string): Promise<FileHandle> {
  const fh = await open(path, constants.O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
  try {
    checkExisting(await fh.stat());
  } catch (e) {
    await fh.close();
    throw e;
  }
  return fh;
}

/** Creates a new file exclusively (fails if it exists), mode 0600. */
export async function createExclusive(path: string): Promise<FileHandle> {
  return open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | O_NOFOLLOW, 0o600);
}
