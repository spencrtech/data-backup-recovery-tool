const test = require('node:test');
const assert = require('node:assert/strict');
const { mongoDefaultsFromUri } = require('../src/server');

test('infers MongoDB database and authentication defaults from a URI', () => {
    assert.deepEqual(
        mongoDefaultsFromUri('mongodb+srv://user:secret@example.mongodb.net/orders?retryWrites=true&authSource=users'),
        { database: 'orders', authDatabase: 'users' }
    );
    assert.deepEqual(
        mongoDefaultsFromUri('mongodb+srv://user:secret@example.mongodb.net/?appName=Spencer'),
        { database: '', authDatabase: 'admin' }
    );
});
