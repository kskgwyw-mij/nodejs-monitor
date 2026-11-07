/**
 * Loads variables from a .env file if one exists. Variables already set in the
 * environment take precedence over the file.
 *
 * This is done in code rather than with `node --env-file-if-exists`, because
 * Node 25's `--watch` mode crashes when that file doesn't exist.
 */
export function loadDotEnv(path = '.env') {
  try {
    process.loadEnvFile(path);
    return true;
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    throw err;
  }
}
