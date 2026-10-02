export const ExitCode = {
  success: 0,
  usage: 2,
  notFound: 3,
  conflict: 4,
  forbidden: 5,
  timeout: 6,
  limit: 7,
  daemon: 8,
  internal: 9,
  interrupted: 130,
} as const;

export type ExitCode = (typeof ExitCode)[keyof typeof ExitCode];
