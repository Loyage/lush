/** Tests use the public registration boundary, never a raw Project attach escape hatch. */
export function registerHook(project, definition) {
  const before = project.hooksList();
  const after = project.saveHookTemplate(definition, before.registry.revision);
  const item = after.templates.at(-1);
  return { template_id: item.id, template_version: item.version };
}
export function attachRegisteredHook(project, workerId, definition) {
  const reference = definition.template_id ? definition : registerHook(project, definition);
  return project.attachTaskHook(workerId, reference, project.taskHooks(workerId).revision);
}
