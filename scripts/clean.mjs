// Copyright 2026 MB AFKzona Group
// SPDX-License-Identifier: Apache-2.0
// Removes the build output directory before a fresh build.
import { rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const dist = fileURLToPath(new URL('../dist', import.meta.url));
await rm(dist, { recursive: true, force: true });
