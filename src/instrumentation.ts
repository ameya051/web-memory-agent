// Runs once when the Next.js server starts. It starts the extraction sweep
// (spec 6.3), which resumes jobs a stopped process left pending. The sweep runs
// in the background, so startup does not wait for it. Node.js runtime only:
// the store uses pg.

export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { startSweep } = await import('./app/extraction');
    startSweep();
  }
}
