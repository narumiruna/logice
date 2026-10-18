import { blue } from "@radix-ui/colors"
import * as Dialog from "@radix-ui/react-dialog"
import { CheckIcon } from "@radix-ui/react-icons"
import { Button, Text, Theme } from "@radix-ui/themes"
import { QueryClient, QueryClientProvider, queryOptions, useQuery } from "@tanstack/react-query"
import { createRootRoute, createRouter, RouterProvider } from "@tanstack/react-router"
import { useVirtualizer } from "@tanstack/react-virtual"
import { useRef } from "react"

export const fixtureQuery = queryOptions({
  queryKey: ["layout-fixture"],
  queryFn: async () => "Stack compatibility fixture only",
  initialData: "Stack compatibility fixture only",
  staleTime: Infinity,
})

export function StackSample() {
  const scroll = useRef<HTMLDivElement>(null)
  const query = useQuery(fixtureQuery)
  const virtual = useVirtualizer({
    count: 1,
    getScrollElement: () => scroll.current,
    estimateSize: () => 32,
  })
  return (
    <Theme>
      <Text style={{ color: blue.blue11 }}>
        <CheckIcon />
        {query.data}
      </Text>
      <Dialog.Root>
        <Dialog.Trigger asChild>
          <Button>Primitive compatibility</Button>
        </Dialog.Trigger>
        <Dialog.Portal>
          <Dialog.Overlay />
          <Dialog.Content>
            <Dialog.Title>Fixture dialog</Dialog.Title>
            <Dialog.Description>Dependency validation, not a product feature.</Dialog.Description>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
      <div
        ref={scroll}
        style={{ height: 32, overflow: "auto" }}
        data-size={virtual.getTotalSize()}
      />
    </Theme>
  )
}

const router = createRouter({ routeTree: createRootRoute({ component: StackSample }) })
const client = new QueryClient()
export function LayoutFixture() {
  return (
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  )
}
