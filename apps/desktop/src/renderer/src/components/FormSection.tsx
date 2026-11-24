/** 表单分区：一组相关字段放在带标题的块里，和其他分区明显分开 */
export function FormSection({ title, extra, children, testId }: { title: React.ReactNode; extra?: React.ReactNode; children: React.ReactNode; testId?: string }): React.JSX.Element {
  return (
    <section className="form-section" data-testid={testId}>
      <div className="form-section-title">
        {title}
        {extra && <span className="extra">{extra}</span>}
      </div>
      {children}
    </section>
  );
}
