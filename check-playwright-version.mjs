// This script checks that the Playwright version in package.json matches the Docker base image
import { readFileSync } from 'fs';

const packageJson = JSON.parse(readFileSync('package.json', 'utf8'));
const playwrightVersion = packageJson.dependencies?.playwright;

if (!playwrightVersion) {
    console.error('ERROR: playwright not found in package.json dependencies');
    process.exit(1);
}

// The expected version should match the Docker image tag
const expectedVersion = '1.56.1';
const actualVersion = playwrightVersion.replace(/[\^~]/, '');

if (actualVersion !== expectedVersion) {
    console.error(`ERROR: Playwright version mismatch!`);
    console.error(`  Expected: ${expectedVersion} (from Docker image)`);
    console.error(`  Found: ${actualVersion} (in package.json)`);
    console.error(`  Please update package.json to use playwright version ${expectedVersion}`);
    process.exit(1);
}

console.log(`✓ Playwright version ${actualVersion} matches Docker image`);
