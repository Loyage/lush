/** A PID handle, not an in-memory ownership tree. */
export class Process {
  constructor(pid, manager) {
    this.pid = pid;
    this.manager = manager;
  }

  inspect() {
    return this.manager.inspect(this.pid);
  }

  getParent() {
    const parent = this.manager.parent(this.pid);
    return parent === null ? null : this.manager.load(parent.pid);
  }

  getChildren() {
    return this.manager.children(this.pid).map((child) => this.manager.load(child.pid));
  }

  createChild(template, { name, goal, variables } = {}) {
    const result = this.manager.spawn(this.pid, template, name, goal, variables);
    return this.manager.load(result.pid);
  }

  async call(prompt) {
    return this.manager.call(this.pid, prompt);
  }
}
