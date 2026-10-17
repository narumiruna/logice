import { createRoot } from "react-dom/client"
import "@radix-ui/themes/styles.css"
import { LayoutFixture } from "./layout"

const root = document.getElementById("root")
if (!root) throw new Error("Missing fixture root")
createRoot(root).render(<LayoutFixture />)
