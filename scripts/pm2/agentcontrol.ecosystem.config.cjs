module.exports = {
  apps: [
    {
      name: 'AgentControl',
      cwd: __dirname + '/../..',
      script: 'npm',
      args: 'run start',
      interpreter: 'none',
      env: {
        NODE_ENV: 'production',
        HOST: '127.0.0.1',
        PORT: '7460',
        AGENTCONTROL_HOME: process.env.AGENTCONTROL_HOME || `${process.env.HOME}/.agentcontrol`,
        HERMES_AGENT_DIR: process.env.HERMES_AGENT_DIR || `${process.env.HOME}/.hermes/hermes-agent`,
        HERMES_PYTHON: process.env.HERMES_PYTHON || '',
        HERMES_AGENT_RUN_LIMIT: process.env.HERMES_AGENT_RUN_LIMIT || '10',
        HEARTBEAT_CONCURRENCY: process.env.HEARTBEAT_CONCURRENCY || '2',
      },
      max_restarts: 10,
      min_uptime: '10s',
      kill_timeout: 5000,
      out_file: `${process.env.HOME}/.agentcontrol/logs/agent-control.out.log`,
      error_file: `${process.env.HOME}/.agentcontrol/logs/agent-control.err.log`,
      merge_logs: true,
      time: true,
    },
  ],
};
