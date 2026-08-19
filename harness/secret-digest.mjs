#!/usr/bin/env node
import { digestOf } from './secret-scan.mjs';

const values = process.argv.slice(2);

if (values.length === 0) {
  console.error('usage: node harness/secret-digest.mjs <value> [<value>...]');
  process.exit(2);
}

for (const value of values) {
  console.log(digestOf(value));
}
