import { createContext, useContext } from "react"
import type { Project } from "./project-api"

export const ProjectContext = createContext<{ project: Project; projects: Project[] } | null>(null)
export function useProject() {
  return useContext(ProjectContext)
}
