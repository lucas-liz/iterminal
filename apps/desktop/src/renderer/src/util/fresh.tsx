import { useRef, type ComponentType } from 'react';

/**
 * 弹窗每次打开（或换了编辑目标）都返回一个新的 key；关闭时保持不变，让关闭动画正常播放。
 *
 * antd 的 Form.useForm 实例在弹窗关闭后仍然保留上次的值；下次打开时 initialValues 会和旧值合并，
 * 而且旧值优先——新建时带出上一条的数据、编辑时串数据。用这个 key 让弹窗组件整个重新挂载，
 * 每次打开都是一个全新的表单。
 */
export function useOpenKey(target: unknown): number {
  const seq = useRef(0);
  const last = useRef<unknown>(null);
  if (target !== last.current) {
    if (target) seq.current += 1;
    last.current = target;
  }
  return seq.current;
}

/** 包一层：pick(props) 变成新的真值时重新挂载 Inner */
export function freshOnOpen<P extends object>(Inner: ComponentType<P>, pick: (p: P) => unknown): (p: P) => React.JSX.Element {
  function Fresh(props: P): React.JSX.Element {
    const key = useOpenKey(pick(props));
    return <Inner key={key} {...props} />;
  }
  Fresh.displayName = `Fresh(${Inner.displayName ?? Inner.name})`;
  return Fresh;
}
