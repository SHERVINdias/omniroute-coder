const { execSync } = require('child_process');

try {
  console.log('Running AgentRouter fix script...\n');
  const output = execSync('node fix-agentrouter.js', { 
    encoding: 'utf8',
    cwd: __dirname 
  });
  console.log(output);
} catch (error) {
  console.error('Error running fix script:', error.message);
  if (error.stdout) console.log('STDOUT:', error.stdout);
  if (error.stderr) console.log('STDERR:', error.stderr);
}