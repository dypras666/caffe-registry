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
  const token = localStorage.getItem('cafe_token')
  if (to.meta.requiresAuth && !token) {
    next('/admin/login')
  } else {
    next()
  }
})

export default router
