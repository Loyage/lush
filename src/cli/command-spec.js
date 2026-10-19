// A fragment declares CLI contracts; the catalogue composes them once.
// The dispatcher still owns live authorization and lifecycle admission.
export function defineCommands(register) {
  const entries = [];
  const add = (path, args, description, exampleArgs = '', rpc = [], kind = 'read', advanced = '', details = {}) => {
    entries.push({ path, description, directory: false,
      usage: `lush ${path}${args ? ` ${args}` : ''}`,
      example: `lush ${path}${exampleArgs ? ` ${exampleArgs}` : ''}`,
      rpc, kind, advanced, id: path.replaceAll(' ', '.'), ...details });
  };
  register(add);
  return entries;
}
