<template>
  <div id="app" style="min-height:100vh;background:#1a1a2e;color:#fff;">
    <nav v-if="isLoggedIn" style="background:rgba(255,255,255,0.05);padding:15px 20px;display:flex;gap:20px;align-items:center;">
      <h3 style="color:#e94560;">Cafe Azzura</h3>
      <router-link to="/admin/dashboard" style="color:#fff;text-decoration:none;">Dashboard</router-link>
      <router-link to="/admin/products" style="color:#fff;text-decoration:none;">Products</router-link>
      <router-link to="/admin/orders" style="color:#fff;text-decoration:none;">Orders</router-link>
      <router-link to="/admin/tables" style="color:#fff;text-decoration:none;">Tables</router-link>
      <button @click="logout" style="margin-left:auto;background:#e94560;color:#fff;border:none;padding:8px 16px;border-radius:6px;cursor:pointer;">Logout</button>
    </nav>
    <router-view style="padding:20px;" />
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { useRouter } from 'vue-router'

const router = useRouter()
const isLoggedIn = computed(() => !!localStorage.getItem('cafe_token'))

const logout = () => {
  localStorage.removeItem('cafe_token')
  localStorage.removeItem('cafe_user')
  router.push('/admin/login')
}
</script>
