const { EventEmitter } = require('events');

class EventBus extends EventEmitter {
    publish(type, payload) {
        this.emit('event', { type, payload, timestamp: new Date().toISOString() });
    }

    connect(req, res) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.flushHeaders();
        res.write(`event: connected\ndata: ${JSON.stringify({ timestamp: new Date().toISOString() })}\n\n`);
        const listener = (event) => {
            res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
        };
        const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 25000);
        this.on('event', listener);
        req.on('close', () => {
            clearInterval(heartbeat);
            this.off('event', listener);
        });
    }
}

module.exports = { EventBus };
