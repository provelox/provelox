/**
 * The image's entrypoint: one image, several roles.
 *   api (default)      the platform's API
 *   console            the web console (its production build, shipped inside the image)
 *   install, bootstrap set up or upgrade the platform
 */
const [role = 'api', ...rest] = process.argv.slice(2);

async function start() {
  if (role === 'api') {
    const { startServer } = await import('./main');
    await startServer();
  } else if (role === 'console') {
    const dir = process.env.CONSOLE_DIR ?? '/app/console';
    process.env.PORT ||= '3000';
    // Docker sets HOSTNAME to the container's id, which Next would bind to: listen on every address instead
    process.env.HOSTNAME = '0.0.0.0';
    process.chdir(dir);
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require(`${dir}/server.js`);
  } else {
    const { runCli } = await import('./cli');
    await runCli([role, ...rest]);
  }
}

void start();
