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
    const result = this.manager.construct(this.sid, template, name, goal, variables);
    return this.manager.load(result.sid);
  }

  /**
   * Say something about this node. An embedding caller is user input like any
   * other, so this is `intent.submit` with this SID as the named target — not a
   * root task of its own (`core/intensions.js`).
   */
  async say(content) {
    return this.manager.submitIntension(content, this.sid, 'sdk');
  }
}
