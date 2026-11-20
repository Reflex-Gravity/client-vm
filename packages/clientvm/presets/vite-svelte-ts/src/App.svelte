<script lang="ts">
  let count = $state(0);
</script>

<main>
  <h1>Vite + Svelte + TS</h1>
  <button type="button" onclick={() => (count += 1)}>count is {count}</button>
  <p>Edit <code>src/App.svelte</code> and save to test HMR.</p>
</main>
