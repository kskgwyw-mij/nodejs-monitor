export const LIMITS = Object.freeze({
  usernameMin: 3,
  usernameMax: 32,
  passwordMin: 12,
  passwordMax: 128,
  titleMax: 100,
  bodyMax: 5000,
});

const USERNAME_RE = /^[a-zA-Z0-9](?:[a-zA-Z0-9_.-]*[a-zA-Z0-9])?$/;

// A handful of the most common passwords that satisfy the length rule.
const COMMON_PASSWORDS = new Set([
  'password1234', '123456789012', 'qwertyuiopas', '1q2w3e4r5t6y', 'passwordpassword',
  'iloveyou1234', 'administrator', 'letmein12345', 'welcome12345', 'qwerty123456',
]);

/**
 * Express' urlencoded parser turns repeated keys into arrays (a=1&a=2).
 * Accept only plain strings so parameter pollution can't confuse later code.
 */
export const str = (value) => (typeof value === 'string' ? value : '');

export function validateCredentials(body, { isNew }) {
  const username = str(body?.username).trim();
  const password = str(body?.password);
  const errors = {};

  if (username.length < LIMITS.usernameMin || username.length > LIMITS.usernameMax) {
    errors.username = `Username must be ${LIMITS.usernameMin}–${LIMITS.usernameMax} characters.`;
  } else if (!USERNAME_RE.test(username)) {
    errors.username = 'Use letters, numbers, dots, dashes and underscores only.';
  }

  if (password.length > LIMITS.passwordMax) {
    errors.password = `Password must be at most ${LIMITS.passwordMax} characters.`;
  } else if (isNew) {
    if (password.length < LIMITS.passwordMin) {
      errors.password = `Password must be at least ${LIMITS.passwordMin} characters.`;
    } else if (COMMON_PASSWORDS.has(password.toLowerCase()) || (username && password.toLowerCase().includes(username.toLowerCase()))) {
      errors.password = 'That password is too easy to guess. Please choose another.';
    }
  } else if (password.length === 0) {
    errors.password = 'Enter your password.';
  }

  return { username, password, errors, valid: Object.keys(errors).length === 0 };
}

export function validateNote(body) {
  const title = str(body?.title).trim();
  const noteBody = str(body?.body).replace(/\r\n/g, '\n').trim();
  const errors = {};

  if (title.length === 0) errors.title = 'Give your note a title.';
  else if (title.length > LIMITS.titleMax) errors.title = `Title must be at most ${LIMITS.titleMax} characters.`;

  if (noteBody.length > LIMITS.bodyMax) errors.body = `Note must be at most ${LIMITS.bodyMax} characters.`;

  return { title, body: noteBody, errors, valid: Object.keys(errors).length === 0 };
}

/** Parses a positive integer route parameter, or returns null. */
export function parseId(value) {
  return /^[1-9]\d{0,14}$/.test(value) ? Number(value) : null;
}
