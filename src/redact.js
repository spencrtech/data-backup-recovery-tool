function redactSensitive(value) {
    return String(value || '')
        .replace(/(mongodb(?:\+srv)?:\/\/)([^@\s/]+)@/gi, '$1[credentials-redacted]@')
        .replace(/((?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key)(?:id)?\s*[=:]\s*)([^&\s,;]+)/gi, '$1[redacted]')
        .replace(/-----BEGIN [^-]+ PRIVATE KEY-----[\s\S]*?-----END [^-]+ PRIVATE KEY-----/g, '[private-key-redacted]');
}

module.exports = { redactSensitive };
