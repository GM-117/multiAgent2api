import styles from "./Section.module.less"

export function Section({
  title,
  right,
  children,
}: {
  title: string
  right?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <div className={styles.section}>
      {right ? (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
            flexWrap: "wrap",
            marginBottom: 12,
          }}
        >
          <div className={styles.sectionTitle} style={{ marginBottom: 0 }}>
            {title}
          </div>
          {right}
        </div>
      ) : (
        <div className={styles.sectionTitle}>{title}</div>
      )}
      {children}
    </div>
  )
}
