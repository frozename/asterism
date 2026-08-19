// Required so `node --test test/` treats `test/` as the requested entrypoint; Bun discovers *.test.mjs without it.
import './no-deps.test.mjs';
import './repo-hygiene.test.mjs';
