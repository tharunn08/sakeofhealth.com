#!/usr/bin/env node
/**
 * npm run dev — local development server with mock payments, on Windows, macOS and Linux alike
 * (the old "PAYMENT_MOCK=true node …" form does not work in PowerShell or cmd). Never for production.
 */
'use strict';
if (process.env.NODE_ENV === 'production') { console.error('npm run dev is for development; use npm start in production.'); process.exit(1); }
process.env.PAYMENT_MOCK = process.env.PAYMENT_MOCK || 'true';
require('../src/server.js');
