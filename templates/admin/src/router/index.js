import { createRouter, createWebHistory } from 'vue-router'

const routes = [
  { path: '/admin/login', name: 'Login', component: () => import('../views/Login.vue') },
  { path: '/admin/dashboard', name: 'Dashboard', component: () => import('../views/Dashboard.vue'), meta: { requiresAuth: true } },
  { path: '/admin/products', name: 'Products', component: () => import('../views/Products.vue'), meta: { requiresAuth: true } },
  { path: '/admin/orders', name: 'Orders', component: () => import('../views/Orders.vue'), meta: { requiresAuth: true } },
  { path: '/admin/tables', name: 'Tables', component: () => import('../views/Tables.vue'), meta: { requiresAuth: true } },
  { path: '/admin/:pathMatch(.*)*', redirect: '/admin/dashboard' }
]

const router = createRouter({
  history: createWebHistory('/admin/'),
  routes
})

router.beforeEach((to, from, next) => {
  // SSO Token support
  if (to.query.sso_token) {
    localStorage.setItem('cafe_token', to.query.sso_token);
    // Remove token from URL for security
    const query = { ...to.query };
    delete query.sso_token;
    return next({ path: to.path, query });
  }

  const token = localStorage.getItem('cafe_token')
  if (to.meta.requiresAuth && !token) {
    next({ path: '/admin/login', query: to.query })
  } else {
    next()
  }
})

export default router
