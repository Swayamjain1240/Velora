#!/usr/bin/env node
// Generates strong random values for the server-only environment variables.
// Prints values to stdout so the operator can paste them into an untracked .env.
'use strict';

const crypto = require('node:crypto');

const pepper = crypto.randomBytes(32).toString('base64url');
const mfaKey = crypto.randomBytes(32).toString('base64');

console.log('SESSION_PEPPER=' + pepper);
console.log('MFA_ENCRYPTION_KEY=' + mfaKey);
console.log('\nPaste these into your untracked .env file. Never commit them.');
