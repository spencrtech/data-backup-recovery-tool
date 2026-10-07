const { startServer } = require('./src/server');

startServer().catch((error) => {
    console.error('Unable to start Spencer Data Backup:', error);
    process.exit(1);
});
