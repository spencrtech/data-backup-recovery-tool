const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { pipeline } = require('stream/promises');
const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getStorage } = require('firebase-admin/storage');
const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, HeadBucketCommand } = require('@aws-sdk/client-s3');

function safeJoin(root, filename) {
    const resolvedRoot = path.resolve(root);
    const target = path.resolve(resolvedRoot, filename);
    if (!target.startsWith(`${resolvedRoot}${path.sep}`)) throw new Error('Unsafe destination path');
    return target;
}

async function testLocal(config) {
    const directory = path.resolve(config.path);
    await fsp.mkdir(directory, { recursive: true });
    await fsp.access(directory, fs.constants.R_OK | fs.constants.W_OK);
    const stats = await fsp.statfs(directory);
    return {
        ok: true,
        detail: 'Directory is readable and writable',
        metrics: { totalBytes: stats.blocks * stats.bsize, freeBytes: stats.bavail * stats.bsize }
    };
}

function firebaseApp(name, config, secret) {
    const existing = getApps().find((item) => item.name === name);
    if (existing) return existing;
    const serviceAccount = typeof secret.serviceAccount === 'string'
        ? JSON.parse(secret.serviceAccount)
        : secret.serviceAccount;
    return initializeApp({
        credential: cert(serviceAccount),
        storageBucket: config.bucket
    }, name);
}

function createS3Client(config, secret) {
    return new S3Client({
        region: config.region || 'us-east-1',
        endpoint: config.endpoint || undefined,
        forcePathStyle: Boolean(config.forcePathStyle),
        credentials: secret?.accessKeyId ? {
            accessKeyId: secret.accessKeyId,
            secretAccessKey: secret.secretAccessKey,
            sessionToken: secret.sessionToken || undefined
        } : undefined
    });
}

async function testDestination(destination, secret) {
    const config = JSON.parse(destination.config);
    if (destination.type === 'local') return testLocal(config);
    if (destination.type === 'firebase') {
        const app = firebaseApp(`spencer-test-${destination.id}`, config, secret);
        const [exists] = await getStorage(app).bucket().exists();
        if (!exists) throw new Error('Firebase bucket does not exist or is inaccessible');
        return { ok: true, detail: `Connected to ${config.bucket}` };
    }
    if (destination.type === 's3') {
        const client = createS3Client(config, secret);
        await client.send(new HeadBucketCommand({ Bucket: config.bucket }));
        return { ok: true, detail: `Connected to ${config.bucket}` };
    }
    throw new Error(`Unsupported destination type: ${destination.type}`);
}

async function upload(destination, secret, filePath, filename, metadata = {}) {
    const config = JSON.parse(destination.config);
    if (destination.type === 'local') {
        await fsp.mkdir(config.path, { recursive: true });
        const target = safeJoin(config.path, filename);
        if (path.resolve(filePath) !== target) await fsp.copyFile(filePath, target);
        return { location: target };
    }
    if (destination.type === 'firebase') {
        const app = firebaseApp(`spencer-${destination.id}`, config, secret);
        const objectName = [config.prefix || 'backups', filename].filter(Boolean).join('/');
        await getStorage(app).bucket().upload(filePath, {
            destination: objectName,
            resumable: true,
            metadata: { contentType: 'application/gzip', metadata }
        });
        return { location: `firebase://${config.bucket}/${objectName}` };
    }
    if (destination.type === 's3') {
        const key = [config.prefix || 'backups', filename].filter(Boolean).join('/');
        const stream = fs.createReadStream(filePath);
        const size = (await fsp.stat(filePath)).size;
        const client = createS3Client(config, secret);
        await client.send(new PutObjectCommand({
            Bucket: config.bucket,
            Key: key,
            Body: stream,
            ContentLength: size,
            ContentType: 'application/gzip',
            Metadata: metadata
        }));
        return { location: `s3://${config.bucket}/${key}` };
    }
    throw new Error(`Unsupported destination type: ${destination.type}`);
}

function objectPath(location, scheme, bucket) {
    const prefix = `${scheme}://${bucket}/`;
    if (!location.startsWith(prefix)) throw new Error(`Artifact does not belong to ${bucket}`);
    return location.slice(prefix.length);
}

async function download(destination, secret, location, targetPath) {
    const config = JSON.parse(destination.config);
    await fsp.mkdir(path.dirname(targetPath), { recursive: true });
    if (destination.type === 'local') {
        await fsp.copyFile(path.resolve(location), targetPath);
        return targetPath;
    }
    if (destination.type === 'firebase') {
        const app = firebaseApp(`spencer-${destination.id}`, config, secret);
        const objectName = objectPath(location, 'firebase', config.bucket);
        await getStorage(app).bucket().file(objectName).download({ destination: targetPath });
        return targetPath;
    }
    if (destination.type === 's3') {
        const key = objectPath(location, 's3', config.bucket);
        const response = await createS3Client(config, secret).send(new GetObjectCommand({ Bucket: config.bucket, Key: key }));
        await pipeline(response.Body, fs.createWriteStream(targetPath, { mode: 0o600 }));
        return targetPath;
    }
    throw new Error(`Unsupported destination type: ${destination.type}`);
}

async function remove(destination, secret, location) {
    const config = JSON.parse(destination.config);
    if (destination.type === 'local') {
        const target = path.resolve(location);
        const root = path.resolve(config.path);
        if (!target.startsWith(`${root}${path.sep}`)) throw new Error('Artifact is outside the destination root');
        await fsp.rm(target, { force: true });
        return;
    }
    if (destination.type === 'firebase') {
        const app = firebaseApp(`spencer-${destination.id}`, config, secret);
        await getStorage(app).bucket().file(objectPath(location, 'firebase', config.bucket)).delete({ ignoreNotFound: true });
        return;
    }
    if (destination.type === 's3') {
        await createS3Client(config, secret).send(new DeleteObjectCommand({
            Bucket: config.bucket,
            Key: objectPath(location, 's3', config.bucket)
        }));
        return;
    }
    throw new Error(`Unsupported destination type: ${destination.type}`);
}

module.exports = { testDestination, upload, download, remove };
