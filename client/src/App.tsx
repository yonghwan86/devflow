import { useEffect } from "react";
import { Route, Switch, useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { Layout } from "./components/Layout";
import Login from "./pages/Login";
import MyWork from "./pages/MyWork";
import Projects from "./pages/Projects";
import ProjectMembers from "./pages/ProjectMembers";
import ProjectBoard from "./pages/ProjectBoard";
import TaskDetail from "./pages/TaskDetail";
import Skills from "./pages/Skills";
import Ai from "./pages/Ai";
import Preview from "./pages/Preview";
import Admin from "./pages/Admin";
import Meetings from "./pages/Meetings";
import ProjectPages from "./pages/ProjectPages";
import Gallery from "./pages/Gallery";
import InviteAccept from "./pages/InviteAccept";
import { useAuth } from "./hooks/useAuth";
import { get } from "./lib/api";
import { Spinner } from "./components/ui";
import { getActiveProject } from "./lib/activeProject";

// 로그인 직후 "/" — 활성(마지막) 프로젝트 보드로 바로 진입. 없으면 첫 프로젝트, 그것도 없으면 목록.
function Home() {
  const [, navigate] = useLocation();
  const projectsQ = useQuery<{ projects: any[] }>({ queryKey: ["projects"], queryFn: () => get("/projects") });

  useEffect(() => {
    const active = getActiveProject();
    if (active) {
      navigate(`/projects/${active.id}`, { replace: true });
      return;
    }
    if (!projectsQ.data) return;
    const list = projectsQ.data.projects ?? [];
    if (list.length > 0) navigate(`/projects/${list[0].id}`, { replace: true });
    else navigate("/projects", { replace: true });
  }, [projectsQ.data, navigate]);

  return <div className="py-16"><Spinner /></div>;
}

export default function App() {
  const { user, isLoading } = useAuth();

  if (isLoading) {
    return <div className="flex h-full items-center justify-center text-slate-400">로딩 중…</div>;
  }
  if (!user) return <Login />;

  return (
    <Layout>
      <Switch>
        <Route path="/" component={Home} />
        <Route path="/invite" component={InviteAccept} />
        <Route path="/my-work" component={MyWork} />
        <Route path="/projects" component={Projects} />
        <Route path="/projects/:id/members" component={ProjectMembers} />
        <Route path="/projects/:id/tasks/:key" component={TaskDetail} />
        <Route path="/projects/:id/preview" component={Preview} />
        <Route path="/projects/:id/meetings" component={Meetings} />
        <Route path="/projects/:id/pages" component={ProjectPages} />
        <Route path="/projects/:id" component={ProjectBoard} />
        <Route path="/skills" component={Skills} />
        <Route path="/ai" component={Ai} />
        <Route path="/gallery" component={Gallery} />
        <Route path="/admin" component={Admin} />
        <Route>404 — 페이지를 찾을 수 없습니다.</Route>
      </Switch>
    </Layout>
  );
}
