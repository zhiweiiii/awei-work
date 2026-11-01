import { labelOf, type PetSession } from "./agents";
import { indicatorLabel, type ProjectIndicator } from "./projectIndicators";

export function ProjectDots({
  projects,
  pending,
  stale,
  onSelect,
  onMore,
}: {
  projects: ProjectIndicator[];
  pending: boolean;
  stale: boolean;
  onSelect: (session: PetSession) => void;
  onMore: () => void;
}) {
  const visible = projects.length > 4 ? projects.slice(0, 3) : projects;
  if (!projects.length) return null;
  return (
    <section className="pet-project-dots" aria-label="项目状态">
      {visible.map((project) => {
        const label = `${labelOf(project.session)} · ${stale ? "状态更新失败" : indicatorLabel(project)}`;
        return (
          <button
            key={project.key}
            type="button"
            className="pet-project-dot"
            data-status={stale ? "unknown" : project.status}
            title={label}
            aria-label={label}
            disabled={pending || stale}
            onClick={() => onSelect(project.session)}
          >
            <span />
          </button>
        );
      })}
      {projects.length > 4 ? (
        <button
          type="button"
          className="pet-project-dot pet-project-more"
          aria-label={`查看其余 ${projects.length - 3} 个项目`}
          title={`其余 ${projects.length - 3} 个项目`}
          disabled={pending || stale}
          onClick={onMore}
        >
          {projects.length - 3 > 99 ? "99+" : `+${projects.length - 3}`}
        </button>
      ) : null}
    </section>
  );
}
