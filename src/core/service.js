/** A SID handle, not an in-memory ownership tree. */
export class Service {
  constructor(sid, manager) {
    this.sid = sid;
    this.manager = manager;
  }

  inspect() {
    return this.manager.inspect(this.sid);
  }

  getParent() {
    const parent = this.manager.parent(this.sid);
    return parent === null ? null : this.manager.load(parent.sid);
  }

  getChildren() {
    return this.manager.children(this.sid).map((child) => this.manager.load(child.sid));
  }

  createChild(template, { name, goal, variables } = {}) {
    const result = this.manager.spawn(this.sid, template, name, goal, variables);
    return this.manager.load(result.sid);
  }

  async call(prompt) {
    return this.manager.call(this.sid, prompt);
  }
}
