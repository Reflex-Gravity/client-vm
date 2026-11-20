<script setup lang="ts">
const count = ref(0);
// Rendered on the server, then reused on the client without a second request.
const { data } = await useFetch('/api/hello');
</script>

<template>
  <main>
    <h1>Nuxt</h1>
    <p>{{ data?.message }}</p>
    <button type="button" @click="count++">count is {{ count }}</button>
    <p>
      Edit <code>app/pages/index.vue</code> and save to test HMR, or
      <NuxtLink to="/about">open another page</NuxtLink>.
    </p>
  </main>
</template>
