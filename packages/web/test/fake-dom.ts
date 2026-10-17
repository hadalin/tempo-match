type Listener = (event: FakeEvent) => unknown;

export interface FakeEvent {
  preventDefault(): void;
}

export class FakeElement {
  id = '';
  className = '';
  disabled = false;
  min = '';
  max = '';
  children: (FakeElement | string)[] = [];
  private attributes = new Map<string, string>();
  private text = '';
  private listeners = new Map<string, Listener[]>();

  get value(): string {
    return this.text;
  }

  set value(value: string | number) {
    this.text = String(value);
  }

  get textContent(): string {
    return this.children.map((child) => (typeof child === 'string' ? child : child.textContent)).join('');
  }

  set textContent(text: string) {
    this.children = [text];
  }

  append(...nodes: (FakeElement | string)[]): void {
    this.children.push(...nodes);
  }

  replaceChildren(...nodes: (FakeElement | string)[]): void {
    this.children = nodes;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  select(): void {}

  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  /** Resolves once every listener's returned promise settles. */
  async dispatch(type: string): Promise<void> {
    const event = { preventDefault() {} };
    await Promise.all((this.listeners.get(type) ?? []).map((listener) => listener(event)));
  }
}

export function fakeDocument(ids: string[]) {
  const elements = new Map(ids.map((id) => {
    const element = new FakeElement();
    element.id = id;
    return [id, element];
  }));
  return {
    elements,
    getElementById: (id: string) => elements.get(id) ?? null,
    createElement: () => new FakeElement(),
    createElementNS: () => new FakeElement(),
  };
}
