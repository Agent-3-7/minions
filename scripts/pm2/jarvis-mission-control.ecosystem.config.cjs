module.exports = {
  apps: [
    {
      name: 'jarvis-mission-control',
      cwd: __dirname + '/../..',
      script: 'npm',
      args: 'run start',
      interpreter: 'none',
      env: {
        NODE_ENV: 'production',
        HOST: '127.0.0.1',
        PORT: '6969',
        MINIONS_HOME: process.env.MINIONS_HOME || `${process.env.HOME}/.minions`,
        HERMES_AGENT_DIR: process.env.HERMES_AGENT_DIR || `${process.env.HOME}/.hermes/hermes-agent`,
        HERMES_PYTHON: process.env.HERMES_PYTHON || '',
        HERMES_AGENT_RUN_LIMIT: process.env.HERMES_AGENT_RUN_LIMIT || '10',
        HEARTBEAT_CONCURRENCY: process.env.HEARTBEAT_CONCURRENCY || '2',
      },
      max_restarts: 10,
      min_uptime: '10s',
      kill_timeout: 5000,
      out_file: `${process.env.HOME}/.minions/logs/jarvis-mission-control.out.log`,
      error_file: `${process.env.HOME}/.minions/logs/jarvis-mission-control.err.log`,
      merge_logs: true,
      time: true,
    },
  ],
};
