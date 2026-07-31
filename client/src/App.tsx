import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/NotFound";
import { Route, Switch } from "wouter";
import ErrorBoundary from "./components/ErrorBoundary";
import { ThemeProvider } from "./contexts/ThemeContext";
import Home from "./pages/Home";
import Strategies from "./pages/Strategies";
import Studio from "./pages/Studio";

import ApiKeys from "./pages/ApiKeys";
import Backtest from "./pages/Backtest";
import ParameterSnapshots from "./pages/ParameterSnapshots";
import ParameterScan from "./pages/ParameterScan";
import DeploymentWorkbench from "./pages/DeploymentWorkbench";

function Router() {
  // make sure to consider if you need authentication for certain routes
  return (
    <Switch>
      <Route path={"/"} component={Home} />
      <Route path={"/strategies"} component={Strategies} />
      <Route path={"/deployments"} component={DeploymentWorkbench} />
      <Route path={"/studio"} component={Studio} />
      <Route path={"/signals"}>{() => { window.location.href = '/'; return null; }}</Route>
      <Route path={"/positions"}>{() => { window.location.href = '/'; return null; }}</Route>
      <Route path={"/api-keys"} component={ApiKeys} />
      <Route path={"/backtest"} component={Backtest} />
      <Route path={"/snapshots"} component={ParameterSnapshots} />
      <Route path={"/scan"} component={ParameterScan} />
      <Route path={"/404"} component={NotFound} />
      {/* Final fallback route */}
      <Route component={NotFound} />
    </Switch>
  );
}

// NOTE: About Theme
// - First choose a default theme according to your design style (dark or light bg), than change color palette in index.css
//   to keep consistent foreground/background color across components
// - If you want to make theme switchable, pass `switchable` ThemeProvider and use `useTheme` hook

function App() {
  return (
    <ErrorBoundary>
      <ThemeProvider
        defaultTheme="dark"
        // switchable
      >
        <TooltipProvider>
          <Toaster />
          <Router />
        </TooltipProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}

export default App;
