import "../styles/globals.css";
import "./pet.css";

import { ThemeProvider } from "@/modules/theme/ThemeProvider";
import ReactDOM from "react-dom/client";
import { PetApp } from "./PetApp";

if (window.top !== window.self)
  throw new Error("awei-work pet cannot run inside a frame");

ReactDOM.createRoot(document.getElementById("pet-root") as HTMLElement).render(
  <ThemeProvider showBackground={false}>
    <PetApp />
  </ThemeProvider>,
);
