import { createRouter, createWebHistory, RouteRecordRaw } from "vue-router";

import Layout from "./layouts/Layout.vue";
import Dashboard from "./pages/Dashboard.vue";
import Home from "./pages/Home.vue";
import Register from "./pages/Register.vue";
import Login from "./pages/Login.vue";
import TabConfig from "./pages/TabConfig.vue";
import Settings from "./pages/Settings.vue";
import TabNew from "./pages/TabNew.vue";
import PdfTab from "./pages/PdfTab.vue";
import { tabUsesViewer } from "./pdf.js";

const Tab = () => import("./pages/Tab.vue");

const routes: RouteRecordRaw[] = [
    {
        path: "/empty",
        component: Layout,
        children: [
            {
                path: "",
                component: Dashboard,
                children: [
                    {
                        name: "home",
                        path: "/",
                        component: Home,
                    },
                    {
                        path: "/tab/:id/edit/info",
                        component: TabConfig,
                    },
                    {
                        path: "/tab/:id/edit/audio",
                        component: TabConfig,
                    },
                    {
                        path: "/tab/:id/edit/tab-file",
                        component: TabConfig,
                    },
                    {
                        name: "tabNew",
                        path: "/new-tab",
                        component: TabNew,
                    },
                    {
                        name: "tab",
                        path: "/tab/:id",
                        component: Tab,
                        meta: { hideFooter: true },
                        // progs4u: tabs that are not AlphaTab scores (PDF) have no notes,
                        // tracks or playback, so they open in the document viewer instead.
                        beforeEnter: async (to) => {
                            const id = String(to.params.id);
                            if (await tabUsesViewer(id)) {
                                return { name: "pdfTab", params: { id } };
                            }
                        },
                    },
                    {
                        name: "pdfTab",
                        path: "/pdf/:id",
                        component: PdfTab,
                        meta: { hideFooter: true },
                    },
                    {
                        name: "settings",
                        path: "/settings",
                        component: Settings,
                    },
                ],
            },
            {
                name: "register",
                path: "/register",
                component: Register,
            },
            {
                name: "login",
                path: "/login",
                component: Login,
            },
        ],
    },
];

export const router = createRouter({
    linkActiveClass: "active",
    history: createWebHistory(),
    routes,
});

// Demo mode navigation guard
router.beforeEach((to, from, next) => {
    if (window.isDemo === true) {
        // Allow access to Settings, Tab pages, and Register (setup) page only
        const isTabPage = to.path.startsWith("/tab/") || to.path.startsWith("/pdf/");
        const isSettingsPage = to.path === "/settings";
        const isRegisterPage = to.path === "/register";

        if (!isTabPage && !isSettingsPage && !isRegisterPage) {
            // Redirect to demo tab
            next("/tab/1?audio=youtube-VuKSlOT__9s&track=2");
        } else {
            next();
        }
    } else {
        next();
    }
});
