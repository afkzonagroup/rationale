/*
 * Copyright 2026 MB AFKzona Group
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Connectors for Node.js servers: an intake that validates and queues
 * statements, an HTTP handler for it, and a background queue worker.
 *
 * @packageDocumentation
 */

export { createIntake, type Intake, type IntakeOptions, type IntakeResponse } from './intake.js';
export { createNodeHandler, constantTimeEqual, type NodeHandlerOptions } from './node-handler.js';
export { startQueueWorker, type QueueWorker, type WorkerOptions } from './worker.js';
